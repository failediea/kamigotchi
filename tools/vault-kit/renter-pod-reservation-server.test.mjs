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

async function harness({ env = {}, healthy = true, jobs = {}, listingExists } = {}) {
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
    ...(listingExists ? { listingExists } : {}),
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
    assert.equal(third.body.scope, "reservation", "machine-readable scope for the web message");
    assert.equal(third.body.renter, undefined, "the renter address stays in the alert only");
    assert.equal(fourth.status, 429);
    assert.equal(h.alertLines.length, 1, "repeat refusals are rate limited");
    assert.match(h.alertLines[0], /^\[LEASE-ALERT\] RESERVATION_CAP scope=reservation /);
  } finally {
    await h.close();
  }
});

test("429 LEASE_CAP at attest when active leases plus distinct attested listings reach MAX_ACTIVE_LEASES", async () => {
  const h = await harness({ env: { MAX_ACTIVE_LEASES: "2" }, jobs: { 5: { tokenIndex: 5, returned: false } } });
  try {
    const deadline = String(Math.floor(Date.now() / 1000) + 900);
    const quoteFor = async (n, tokenIndex) => {
      const { body } = await h.post(RESERVE_PATH, { nonce: nonce(n), renter: renter(n) });
      return h.post(ATTEST_PATH, { quote: { nonce: nonce(n), renter: renter(n), operator: body.operator, tokenIndex, deadline } });
    };
    // Reserving is never refused for lease capacity by unattested requests.
    for (let n = 10; n < 20; n++) assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(n), renter: renter(n) })).status, 201);
    assert.equal((await quoteFor(1, 8)).status, 200, "listing #8 takes the second slot");
    assert.equal((await quoteFor(2, 8)).status, 200, "a second quote for #8 adds nothing");
    const refused = await quoteFor(3, 9);
    assert.equal(refused.status, 429);
    assert.equal(refused.body.code, "LEASE_CAP");
    assert.equal(refused.body.scope, "market");
    assert.match(h.alertLines[0], /^\[LEASE-ALERT\] LEASE_CAP scope=market active=1 pending=1 cap=2/);
    assert.equal(h.state.reservations[nonce(3)].attestedDigest, undefined, "nothing signed");
  } finally {
    await h.close();
  }
});

test("attest refuses a tokenIndex that is not a real listing", async () => {
  const h = await harness({ listingExists: async (tokenIndex) => tokenIndex === 8 });
  try {
    const { body } = await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1) });
    const quote = { nonce: nonce(1), renter: renter(1), operator: body.operator, tokenIndex: 99 };
    const refused = await h.post(ATTEST_PATH, { quote });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /unknown listing/);
    assert.equal((await h.post(ATTEST_PATH, { quote: { ...quote, tokenIndex: 8 } })).status, 200);
    assert.equal(h.state.reservations[nonce(1)].tokenIndex, 8);
  } finally {
    await h.close();
  }
});

test("attest: signs the digest, records the quote deadline, and enforces renter binding", async () => {
  const h = await harness();
  try {
    const { body } = await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1) });
    const quote = { nonce: nonce(1), renter: renter(1), operator: body.operator, tokenIndex: 4, deadline: "1790000900" };
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
    const refused = await h.post(ATTEST_PATH, { quote: { nonce: nonce(1), renter: renter(2), operator: renter(77), tokenIndex: 4 } });
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
    const refused = await h.post(ATTEST_PATH, { quote: { nonce: nonce(1), renter: renter(1), operator: renter(77), tokenIndex: 4 } });
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

test("final-verify repro: concurrent attests for different listings cannot overrun LEASE_CAP", async () => {
  // Slow listing check: every attest is parked on this await together.
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const h = await harness({ env: { MAX_ACTIVE_LEASES: "2" }, jobs: { 5: { tokenIndex: 5, returned: false } }, listingExists: () => gate });
  try {
    const quotes = [];
    for (let n = 1; n <= 6; n++) {
      const { body } = await h.post(RESERVE_PATH, { nonce: nonce(n), renter: renter(n) });
      quotes.push({ nonce: nonce(n), renter: renter(n), operator: body.operator, tokenIndex: 100 + n, deadline: "1790000900" });
    }
    // Market at cap - 1 (one active lease, cap 2): fire all six at once.
    const inFlight = quotes.map((quote) => h.post(ATTEST_PATH, { quote }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    release(true);
    const results = await Promise.all(inFlight);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 429, 429, 429, 429, 429], "exactly one attest gets the last slot");
    for (const refused of results.filter((r) => r.status === 429)) {
      assert.equal(refused.body.code, "LEASE_CAP");
      assert.equal(refused.body.scope, "market");
    }
    const signed = Object.values(h.state.reservations).filter((r) => r.attestedDigest);
    assert.equal(signed.length, 1);
    assert.ok(Object.values(h.state.reservations).every((r) => r.attestPendingUntil === undefined), "no slot left held");
  } finally {
    await h.close();
  }
});

test("a failed attest releases its held slot (unknown listing / digest failure)", async () => {
  const h = await harness({ env: { MAX_ACTIVE_LEASES: "1" }, listingExists: async (tokenIndex) => tokenIndex !== 99 });
  try {
    const { body: a } = await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1) });
    const bad = await h.post(ATTEST_PATH, { quote: { nonce: nonce(1), renter: renter(1), operator: a.operator, tokenIndex: 99 } });
    assert.equal(bad.status, 400);
    assert.equal(h.state.reservations[nonce(1)].tokenIndex, undefined, "token rolled back");
    assert.equal(h.state.reservations[nonce(1)].attestPendingUntil, undefined);
    // Wrong operator: bindOperatorReservationQuote throws after the awaits.
    const { body: b } = await h.post(RESERVE_PATH, { nonce: nonce(2), renter: renter(2) });
    const wrong = await h.post(ATTEST_PATH, { quote: { nonce: nonce(2), renter: renter(2), operator: renter(77), tokenIndex: 7 } });
    assert.equal(wrong.status, 400);
    assert.equal(h.state.reservations[nonce(2)].attestPendingUntil, undefined);
    // The only slot is still free for a real quote.
    const good = await h.post(ATTEST_PATH, { quote: { nonce: nonce(2), renter: renter(2), operator: b.operator, tokenIndex: 7 } });
    assert.equal(good.status, 200);
  } finally {
    await h.close();
  }
});

test("429 bodies carry a machine-readable scope for every cap (reservation | renter | lease | market)", async () => {
  const h = await harness({
    env: { MAX_LIVE_RESERVATIONS: "4", MAX_RESERVATIONS_PER_LISTING: "1", MAX_ACTIVE_LEASES: "1" },
    jobs: { 3: { tokenIndex: 3, renter: renter(9), returned: false }, 4: { tokenIndex: 4, renter: renter(9), returned: false } },
  });
  try {
    const reserve = (n, who, extra = {}) => h.post(RESERVE_PATH, { nonce: nonce(n), renter: who, ...extra });
    // renter: renter(9) already holds two active leases.
    const renterCap = await reserve(1, renter(9));
    assert.deepEqual([renterCap.status, renterCap.body.code, renterCap.body.scope], [429, "RESERVATION_CAP", "renter"]);
    // market (LEASE_CAP, early at reserve because tokenIndex is sent).
    const full = await reserve(2, renter(1), { tokenIndex: 8 });
    assert.deepEqual([full.status, full.body.code, full.body.scope], [429, "LEASE_CAP", "market"]);
    // lease: per-listing cap 1 for a listing that is already counted (#3).
    assert.equal((await reserve(3, renter(1), { tokenIndex: 3 })).status, 201);
    const listing = await reserve(4, renter(2), { tokenIndex: 3 });
    assert.deepEqual([listing.status, listing.body.scope], [429, "lease"]);
    // reservation: the per-renter open-checkout cap (2).
    assert.equal((await reserve(5, renter(1))).status, 201);
    const open = await reserve(6, renter(1));
    assert.deepEqual([open.status, open.body.scope], [429, "reservation"]);
    // market (RESERVATION_CAP): 4 live checkouts market-wide.
    assert.equal((await reserve(7, renter(3))).status, 201);
    assert.equal((await reserve(8, renter(4))).status, 201);
    const busy = await reserve(9, renter(5));
    assert.deepEqual([busy.status, busy.body.code, busy.body.scope], [429, "RESERVATION_CAP", "market"]);
    for (const response of [renterCap, full, listing, open, busy]) {
      assert.deepEqual(Object.keys(response.body).sort(), ["code", "error", "scope"]);
    }
  } finally {
    await h.close();
  }
});
