import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createLeaseAlerter } from "./renter-pod-alerts.mjs";
import { hardeningConfigFromEnv } from "./renter-pod-config.mjs";
import { ATTEST_PATH, RESERVE_PATH, createReservationHandler } from "./renter-pod-reservation-server.mjs";

const TOKEN = "t".repeat(40);
const MARKET = "0x00000000000000000000000000000000000000aa";
const FACTORY = "0x00000000000000000000000000000000000000bb";
const DIGEST = `0x${"cd".repeat(32)}`;
const nonce = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const renter = (n) => `0x${n.toString(16).padStart(40, "0")}`;

async function harness({ env = {}, healthy = true, jobs = {} } = {}) {
  const state = { jobs, reservations: {} };
  const events = [];
  const alertLines = [];
  let health = healthy ? { ok: true, reason: "ok" } : { ok: false, reason: "heartbeat-stale" };
  const handler = createReservationHandler({
    state,
    token: TOKEN,
    market: MARKET,
    factory: FACTORY,
    policy: hardeningConfigFromEnv(env),
    health: () => health,
    quoteDigest: async () => DIGEST,
    signDigest: (digest) => `sig(${digest})`,
    saveReservations: () => events.push(["save", JSON.parse(JSON.stringify(state.reservations))]),
    alert: createLeaseAlerter({ log: (line) => alertLines.push(line), minIntervalMs: 60_000 }),
    log: () => {},
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, { auth = `Bearer ${TOKEN}` } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify({ market: MARKET, factory: FACTORY, ...body }),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    state,
    events,
    alertLines,
    post,
    setHealth: (value) => {
      health = value;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("reserve: 201 with an operator, persisted before the response", async () => {
  const h = await harness();
  try {
    const result = await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1) });
    assert.equal(result.status, 201);
    assert.match(result.body.operator, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(h.events.length, 1);
    const saved = h.events[0][1][nonce(1)];
    assert.equal(saved.operator, result.body.operator);
    assert.equal(saved.renter, renter(1));
    // Idempotent retry returns the same operator without another write.
    const again = await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1) });
    assert.equal(again.body.operator, result.body.operator);
    assert.equal(h.events.length, 1);
  } finally {
    await h.close();
  }
});

test("401 without the token; 400 without a renter (web must send it)", async () => {
  const h = await harness();
  try {
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1) }, { auth: "Bearer nope" })).status, 401);
    const missing = await h.post(RESERVE_PATH, { nonce: nonce(1) });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /renter/);
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), market: FACTORY })).status, 400);
  } finally {
    await h.close();
  }
});

test("503 on both routes while the worker is stale or halted", async () => {
  const h = await harness({ healthy: false });
  try {
    const reserve = await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1) });
    assert.equal(reserve.status, 503);
    assert.equal(reserve.body.reason, "heartbeat-stale");
    const attest = await h.post(ATTEST_PATH, { quote: { nonce: nonce(1), renter: renter(1) } });
    assert.equal(attest.status, 503);
    assert.equal(h.events.length, 0, "nothing reserved or signed while unhealthy");
    h.setHealth({ ok: true, reason: "ok" });
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1) })).status, 201);
  } finally {
    await h.close();
  }
});

test("403 for renters outside RENTER_ALLOWLIST", async () => {
  const h = await harness({ env: { RENTER_ALLOWLIST: renter(1) } });
  try {
    const refused = await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(2) });
    assert.equal(refused.status, 403);
    assert.equal(h.events.length, 0);
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(2), renter: renter(1) })).status, 201);
  } finally {
    await h.close();
  }
});

test("429 + one rate-limited RESERVATION_CAP alert line at the per-renter cap", async () => {
  const h = await harness();
  try {
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1) })).status, 201);
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(2), renter: renter(1) })).status, 201);
    const third = await h.post(RESERVE_PATH, { nonce: nonce(3), renter: renter(1) });
    const fourth = await h.post(RESERVE_PATH, { nonce: nonce(4), renter: renter(1) });
    assert.equal(third.status, 429);
    assert.equal(third.body.code, "RESERVATION_CAP");
    assert.equal(fourth.status, 429);
    assert.equal(h.alertLines.length, 1, "repeat refusals are rate limited");
    assert.match(h.alertLines[0], /^\[LEASE-ALERT\] RESERVATION_CAP scope=renter /);
  } finally {
    await h.close();
  }
});

test("429 LEASE_CAP when active leases plus live reservations reach MAX_ACTIVE_LEASES", async () => {
  const h = await harness({ env: { MAX_ACTIVE_LEASES: "2" }, jobs: { 5: { returned: false } } });
  try {
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1) })).status, 201);
    const refused = await h.post(RESERVE_PATH, { nonce: nonce(2), renter: renter(2) });
    assert.equal(refused.status, 429);
    assert.equal(refused.body.code, "LEASE_CAP");
    assert.match(h.alertLines[0], /^\[LEASE-ALERT\] LEASE_CAP active=1 live=1 cap=2/);
  } finally {
    await h.close();
  }
});

test("attest: signs the digest, records the quote deadline, and enforces renter binding", async () => {
  const h = await harness();
  try {
    const { body } = await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1) });
    const quote = { nonce: nonce(1), renter: renter(1), operator: body.operator, deadline: "1790000900" };
    const signed = await h.post(ATTEST_PATH, { quote });
    assert.equal(signed.status, 200);
    assert.equal(signed.body.keeperSignature, `sig(${DIGEST})`);
    const saved = h.events.at(-1)[1][nonce(1)];
    assert.equal(saved.attestedDigest, DIGEST);
    assert.equal(saved.quoteDeadline, 1_790_000_900);

    const wrongRenter = await h.post(ATTEST_PATH, { quote: { ...quote, renter: renter(2) } });
    assert.equal(wrongRenter.status, 400);
    const unknown = await h.post(ATTEST_PATH, { quote: { ...quote, nonce: nonce(9) } });
    assert.equal(unknown.status, 400);
  } finally {
    await h.close();
  }
});

test("attest refuses a renter removed from the allowlist after reserving (403)", async () => {
  const h = await harness({ env: { RENTER_ALLOWLIST: renter(1) } });
  try {
    h.state.reservations[nonce(1)] = { operator: renter(77), operatorKey: "0x00", createdAt: Date.now(), renter: renter(2) };
    const refused = await h.post(ATTEST_PATH, { quote: { nonce: nonce(1), renter: renter(2), operator: renter(77) } });
    assert.equal(refused.status, 403);
  } finally {
    await h.close();
  }
});

test("an unattested reservation past its TTL is never signed", async () => {
  const h = await harness();
  try {
    h.state.reservations[nonce(1)] = {
      operator: renter(77),
      operatorKey: "0x00",
      createdAt: Date.now() - 21 * 60_000,
      renter: renter(1),
    };
    const refused = await h.post(ATTEST_PATH, { quote: { nonce: nonce(1), renter: renter(1), operator: renter(77) } });
    assert.equal(refused.status, 400);
    assert.equal(h.state.reservations[nonce(1)].attestedDigest, undefined);
  } finally {
    await h.close();
  }
});

test("unknown routes are 404", async () => {
  const h = await harness();
  try {
    assert.equal((await h.post("/v1/other", {})).status, 404);
  } finally {
    await h.close();
  }
});
