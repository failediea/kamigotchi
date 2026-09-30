import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createLeaseAlerter } from "./renter-pod-alerts.mjs";
import { hardeningConfigFromEnv } from "./renter-pod-config.mjs";
import { ATTEST_PATH, RELEASE_PATH, RESERVE_PATH, createReservationHandler } from "./renter-pod-reservation-server.mjs";
import { pruneReservations } from "./renter-pod-reservations.mjs";

const TOKEN = "t".repeat(40);
const MARKET = "0x00000000000000000000000000000000000000aa";
const FACTORY = "0x00000000000000000000000000000000000000bb";
const DIGEST = `0x${"cd".repeat(32)}`;
const nonce = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const renter = (n) => `0x${n.toString(16).padStart(40, "0")}`;

// Every harness renter is funded unless a test passes its own balance reader.
const RICH = 10n ** 30n;
// Attest quotes carry the gas totals the keeper signs (REQUIRE_RENTER_BALANCE).
const GAS = { setupGasWei: "1000", hubGasWei: "2000", operatingGasWei: "3000" };

async function harness({ env = {}, healthy = true, jobs = {}, listingExists, renterBalance = async () => RICH, now } = {}) {
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
    renterBalance,
    ...(now ? { now } : {}),
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, { auth = `Bearer ${TOKEN}` } = {}) => {
    const payload = path === ATTEST_PATH && body.quote ? { ...body, quote: { ...GAS, ...body.quote } } : body;
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify({ market: MARKET, factory: FACTORY, ...payload }),
    });
    return { status: response.status, body: await response.json(), retryAfter: response.headers.get("retry-after") };
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

// --- Open-rental (Sybil quote-spam) guards: THR-04 / FE-2 without an allowlist ---

const T0 = 1_790_000_000_000;
const clock = (start = T0) => {
  let at = start;
  return { now: () => at, advance: (ms) => (at += ms), set: (ms) => (at = ms) };
};
const TTL_MS = 1200 * 1000;
const COOLDOWN_MS = 900 * 1000;

test("balance gate at attest: 403 INSUFFICIENT_BALANCE below setup + hub + operating gas, nothing signed, listing freed", async () => {
  let balance = 5_999n;
  const h = await harness({ renterBalance: async () => balance });
  try {
    const { body } = await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 7 });
    const quote = { nonce: nonce(1), renter: renter(1), operator: body.operator, tokenIndex: 7, deadline: "1790000900" };
    const refused = await h.post(ATTEST_PATH, { quote });
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.body, {
      error: "this wallet does not hold enough ETH to fund this lease",
      code: "INSUFFICIENT_BALANCE",
      scope: "renter",
      requiredWei: "6000",
    });
    const entry = h.state.reservations[nonce(1)];
    assert.equal(entry.attestedDigest, undefined, "nothing signed");
    assert.equal(entry.attestPendingUntil, undefined, "slot rolled back");
    assert.equal(entry.releaseReason, "insufficient-balance");
    assert.equal(h.alertLines.length, 0, "a normal user condition, not an alert");
    // The unfunded wallet's reservation holds nothing: another renter can take the Kami now.
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(2), renter: renter(2), tokenIndex: 7 })).status, 201);
    // Exactly enough is enough (new quote: the refused nonce stays released).
    balance = 6_000n;
    const { body: again } = await h.post(RESERVE_PATH, { nonce: nonce(3), renter: renter(3), tokenIndex: 8 });
    const ok = await h.post(ATTEST_PATH, { quote: { ...quote, nonce: nonce(3), renter: renter(3), operator: again.operator, tokenIndex: 8 } });
    assert.equal(ok.status, 200);
    assert.equal((await h.post(ATTEST_PATH, { quote })).status, 400, "a released reservation is never signed");
  } finally {
    await h.close();
  }
});

test("balance gate fails CLOSED: an RPC failure is 503 BALANCE_UNAVAILABLE, never a signature or a reservation", async () => {
  const h = await harness({
    renterBalance: async () => {
      throw new Error("rpc down");
    },
  });
  try {
    const { body } = await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1) });
    const attest = await h.post(ATTEST_PATH, { quote: { nonce: nonce(1), renter: renter(1), operator: body.operator, tokenIndex: 7 } });
    assert.equal(attest.status, 503);
    assert.equal(attest.body.code, "BALANCE_UNAVAILABLE");
    assert.equal(attest.retryAfter, "60");
    const entry = h.state.reservations[nonce(1)];
    assert.equal(entry.attestedDigest, undefined);
    assert.equal(entry.attestPendingUntil, undefined, "slot rolled back");
    assert.equal(entry.releasedAt, undefined, "an RPC failure is not the renter's fault: nothing released");
    const saves = h.events.length;
    const reserve = await h.post(RESERVE_PATH, { nonce: nonce(2), renter: renter(2), fundingWei: "1" });
    assert.equal(reserve.status, 503);
    assert.equal(reserve.body.code, "BALANCE_UNAVAILABLE");
    assert.equal(h.state.reservations[nonce(2)], undefined, "no operator reserved");
    assert.equal(h.events.length, saves);
  } finally {
    await h.close();
  }
});

test("balance gate at reserve (web sends fundingWei after pricing): refused before an operator is spent", async () => {
  const h = await harness({ renterBalance: async (who) => (who === renter(1) ? 10_000n : 0n) });
  try {
    const poor = await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(2), tokenIndex: 7, fundingWei: "6000" });
    assert.equal(poor.status, 403);
    assert.equal(poor.body.code, "INSUFFICIENT_BALANCE");
    assert.equal(poor.body.scope, "renter");
    assert.equal(poor.body.requiredWei, "6000");
    assert.equal(h.events.length, 0, "nothing reserved");
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(2), renter: renter(1), fundingWei: "0x10" })).status, 400);
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(2), renter: renter(1), fundingWei: "-1" })).status, 400);
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(2), renter: renter(1), tokenIndex: 7, fundingWei: "10000" })).status, 201);
    // Without fundingWei the reserve is not gated; the attest still is (authoritative).
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(3), renter: renter(2) })).status, 201);
  } finally {
    await h.close();
  }
});

test("balance gate: attest requires the quote gas totals; REQUIRE_RENTER_BALANCE=off skips the read", async () => {
  const h = await harness();
  try {
    const { body } = await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1) });
    const quote = { nonce: nonce(1), renter: renter(1), operator: body.operator, tokenIndex: 7, hubGasWei: undefined };
    const missing = await h.post(ATTEST_PATH, { quote });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /hubGasWei/);
    assert.equal(h.state.reservations[nonce(1)].attestPendingUntil, undefined);
  } finally {
    await h.close();
  }
  const off = await harness({
    env: { REQUIRE_RENTER_BALANCE: "off" },
    renterBalance: async () => {
      throw new Error("must not be called");
    },
  });
  try {
    const { body } = await off.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), fundingWei: "1" });
    assert.equal((await off.post(ATTEST_PATH, { quote: { nonce: nonce(1), renter: renter(1), operator: body.operator, tokenIndex: 7 } })).status, 200);
  } finally {
    await off.close();
  }
  assert.throws(
    () => createReservationHandler({ state: {}, token: TOKEN, market: MARKET, factory: FACTORY, policy: hardeningConfigFromEnv({}) }),
    /REQUIRE_RENTER_BALANCE is on/,
    "the gate is never silently skipped"
  );
});

test("single checkout per Kami: another renter gets 429 scope=lease + Retry-After; the holder may re-quote; release frees it", async () => {
  const c = clock();
  const h = await harness({ now: c.now });
  try {
    const deadlineSec = Math.floor(T0 / 1000) + 900;
    const { body } = await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 7 });
    const quote = { nonce: nonce(1), renter: renter(1), operator: body.operator, tokenIndex: 7, deadline: String(deadlineSec) };
    assert.equal((await h.post(ATTEST_PATH, { quote })).status, 200);
    c.advance(60_000);
    const blocked = await h.post(RESERVE_PATH, { nonce: nonce(2), renter: renter(2), tokenIndex: 7 });
    assert.equal(blocked.status, 429);
    assert.deepEqual(Object.keys(blocked.body).sort(), ["code", "error", "scope"], "429 body shape unchanged");
    assert.deepEqual([blocked.body.code, blocked.body.scope], ["RESERVATION_CAP", "lease"]);
    assert.equal(blocked.retryAfter, "840", "until the holder's quote deadline");
    assert.equal(h.state.reservations[nonce(2)], undefined);
    // Other Kamis are unaffected; the holder itself may re-quote its Kami (wallet rejected the tx).
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(3), renter: renter(2), tokenIndex: 8 })).status, 201);
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(4), renter: renter(1), tokenIndex: 7 })).status, 201);
    // The holder closes checkout: both of its reservations are released, the Kami is free at once.
    for (const n of [1, 4]) {
      const released = await h.post(RELEASE_PATH, { nonce: nonce(n), renter: renter(1) });
      assert.deepEqual([released.status, released.body], [200, { released: true }]);
    }
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(5), renter: renter(2), tokenIndex: 7 })).status, 201);
  } finally {
    await h.close();
  }
  // Past the quote deadline an attested quote no longer holds the Kami either.
  const c2 = clock();
  const h2 = await harness({ now: c2.now });
  try {
    const deadlineSec = Math.floor(T0 / 1000) + 900;
    const { body } = await h2.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 7 });
    const quote = { nonce: nonce(1), renter: renter(1), operator: body.operator, tokenIndex: 7, deadline: String(deadlineSec) };
    assert.equal((await h2.post(ATTEST_PATH, { quote })).status, 200);
    c2.set(deadlineSec * 1000 + 1);
    assert.equal((await h2.post(RESERVE_PATH, { nonce: nonce(2), renter: renter(2), tokenIndex: 7 })).status, 201);
  } finally {
    await h2.close();
  }
});

test("single checkout per Kami: concurrent reserves from different renters admit exactly one (balance read first)", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const h = await harness({ renterBalance: () => gate.then(() => RICH) });
  try {
    const inFlight = [1, 2, 3, 4, 5].map((n) =>
      h.post(RESERVE_PATH, { nonce: nonce(n), renter: renter(n), tokenIndex: 9, fundingWei: "6000" })
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const statuses = (await Promise.all(inFlight)).map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 429, 429, 429, 429]);
    assert.equal(Object.keys(h.state.reservations).length, 1);
  } finally {
    await h.close();
  }
});

test("listing cooldown: a checkout that EXPIRED unused blocks the same renter on the same Kami; a released one never does", async () => {
  const c = clock();
  const h = await harness({ now: c.now });
  try {
    // Expired unattested (e.g. a spam wallet that never finished): cooldown.
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 7 })).status, 201);
    c.advance(TTL_MS + 1_000);
    const cooling = await h.post(RESERVE_PATH, { nonce: nonce(2), renter: renter(1), tokenIndex: 7 });
    assert.equal(cooling.status, 429);
    assert.deepEqual([cooling.body.code, cooling.body.scope], ["LISTING_COOLDOWN", "lease"]);
    assert.deepEqual(Object.keys(cooling.body).sort(), ["code", "error", "scope"]);
    assert.equal(cooling.retryAfter, String(COOLDOWN_MS / 1000 - 1));
    assert.equal(h.alertLines.length, 0, "cooldowns are not alerts");
    // Only that renter and only that Kami.
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(3), renter: renter(1), tokenIndex: 8 })).status, 201);
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(4), renter: renter(2), tokenIndex: 7 })).status, 201);
    // The pruner removes the expired entry but keeps the cooldown (persisted with the store).
    assert.equal(pruneReservations(h.state, { nowMs: c.now(), ttlMs: TTL_MS, ingestedThroughSec: null, cooldownMs: COOLDOWN_MS }), 1);
    assert.equal(h.state.reservations[nonce(1)], undefined);
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(5), renter: renter(1), tokenIndex: 7 })).body.code, "LISTING_COOLDOWN");
    c.set(T0 + TTL_MS + COOLDOWN_MS + 1);
    // renter(2)'s checkout on #7 still holds (single-checkout lock), until it is released.
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(5), renter: renter(1), tokenIndex: 7 })).body.code, "RESERVATION_CAP");
    assert.equal((await h.post(RELEASE_PATH, { nonce: nonce(4), renter: renter(2) })).status, 200);
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(5), renter: renter(1), tokenIndex: 7 })).status, 201);

    // Released (renter closed checkout / wallet rejected the tx): immediate retry, no cooldown ever.
    c.set(T0 + 10 * TTL_MS);
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(10), renter: renter(3), tokenIndex: 20 })).status, 201);
    assert.equal((await h.post(RELEASE_PATH, { nonce: nonce(10), renter: renter(3) })).status, 200);
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(11), renter: renter(3), tokenIndex: 20 })).status, 201);
    assert.equal((await h.post(RELEASE_PATH, { nonce: nonce(11), renter: renter(3) })).status, 200);
    c.advance(TTL_MS + 1_000);
    pruneReservations(h.state, { nowMs: c.now(), ttlMs: TTL_MS, ingestedThroughSec: null, cooldownMs: COOLDOWN_MS });
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(12), renter: renter(3), tokenIndex: 20 })).status, 201);
  } finally {
    await h.close();
  }
});

test("listing cooldown also follows an attested quote whose deadline passed without a pod", async () => {
  const c = clock();
  const h = await harness({ now: c.now });
  try {
    const deadlineSec = Math.floor(T0 / 1000) + 900;
    const { body } = await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 7 });
    const quote = { nonce: nonce(1), renter: renter(1), operator: body.operator, tokenIndex: 7, deadline: String(deadlineSec) };
    assert.equal((await h.post(ATTEST_PATH, { quote })).status, 200);
    c.set(deadlineSec * 1000 + 5_000);
    const cooling = await h.post(RESERVE_PATH, { nonce: nonce(2), renter: renter(1), tokenIndex: 7 });
    assert.equal(cooling.body.code, "LISTING_COOLDOWN");
    assert.equal(cooling.retryAfter, String(COOLDOWN_MS / 1000 - 5));
    // Pruned only once ingest covered the deadline; the cooldown survives the prune.
    c.set(T0 + TTL_MS + 1_000);
    assert.equal(pruneReservations(h.state, { nowMs: c.now(), ttlMs: TTL_MS, ingestedThroughSec: deadlineSec + 1, cooldownMs: COOLDOWN_MS }), 1);
    assert.equal(h.state.listingCooldowns[`${renter(1)}:7`], deadlineSec * 1000 + COOLDOWN_MS);
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(2), renter: renter(1), tokenIndex: 7 })).body.code, "LISTING_COOLDOWN");
  } finally {
    await h.close();
  }
});

test("release/retry is bounded per wallet (MAX_RESERVATION_ATTEMPTS_PER_RENTER) so one wallet cannot fill MAX_LIVE_RESERVATIONS", async () => {
  const h = await harness();
  try {
    for (let n = 1; n <= 6; n++) {
      assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(n), renter: renter(1), tokenIndex: 7 })).status, 201, `attempt ${n}`);
      assert.equal((await h.post(RELEASE_PATH, { nonce: nonce(n), renter: renter(1) })).status, 200);
    }
    const seventh = await h.post(RESERVE_PATH, { nonce: nonce(7), renter: renter(1), tokenIndex: 7 });
    assert.deepEqual([seventh.status, seventh.body.code, seventh.body.scope], [429, "RESERVATION_CAP", "reservation"]);
    assert.match(h.alertLines.at(-1), /RESERVATION_CAP scope=reservation .*attempts=6 cap=6/);
    // Released checkouts do not count as open ones.
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(8), renter: renter(2) })).status, 201);
    assert.equal((await h.post(RELEASE_PATH, { nonce: nonce(8), renter: renter(2) })).status, 200);
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(9), renter: renter(2) })).status, 201);
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(10), renter: renter(2) })).status, 201, "two open + one released");
  } finally {
    await h.close();
  }
});

test("release route: authenticated, renter-bound, idempotent, answered while halted; a released nonce is dead", async () => {
  const h = await harness();
  try {
    const { body } = await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 7 });
    assert.equal((await h.post(RELEASE_PATH, { nonce: nonce(1), renter: renter(1) }, { auth: "Bearer nope" })).status, 401);
    assert.equal((await h.post(RELEASE_PATH, { nonce: nonce(1), renter: renter(1), market: FACTORY })).status, 400);
    const stranger = await h.post(RELEASE_PATH, { nonce: nonce(1), renter: renter(2) });
    assert.equal(stranger.status, 400);
    assert.equal(h.state.reservations[nonce(1)].releasedAt, undefined);
    assert.equal((await h.post(RELEASE_PATH, { nonce: nonce(1), renter: "nope" })).status, 400);
    h.setHealth({ ok: false, reason: "halted" });
    const saves = h.events.length;
    assert.deepEqual((await h.post(RELEASE_PATH, { nonce: nonce(1), renter: renter(1) })).body, { released: true });
    assert.equal(h.events.length, saves + 1, "persisted");
    assert.deepEqual((await h.post(RELEASE_PATH, { nonce: nonce(1), renter: renter(1) })).body, { released: false });
    assert.deepEqual((await h.post(RELEASE_PATH, { nonce: nonce(99), renter: renter(1) })).body, { released: false });
    h.setHealth({ ok: true, reason: "ok" });
    assert.equal(h.state.reservations[nonce(1)].operator, body.operator, "the key is kept until the pruner proves it unusable");
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 7 })).status, 400);
    assert.equal((await h.post(ATTEST_PATH, { quote: { nonce: nonce(1), renter: renter(1), operator: body.operator, tokenIndex: 7 } })).status, 400);
  } finally {
    await h.close();
  }
});

test("a released ATTESTED quote still counts toward LEASE_CAP (it can still be submitted on-chain)", async () => {
  const h = await harness({ env: { MAX_ACTIVE_LEASES: "1" } });
  try {
    const { body } = await h.post(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 7 });
    const deadline = String(Math.floor(Date.now() / 1000) + 900);
    assert.equal((await h.post(ATTEST_PATH, { quote: { nonce: nonce(1), renter: renter(1), operator: body.operator, tokenIndex: 7, deadline } })).status, 200);
    assert.equal((await h.post(RELEASE_PATH, { nonce: nonce(1), renter: renter(1) })).status, 200);
    const full = await h.post(RESERVE_PATH, { nonce: nonce(2), renter: renter(2), tokenIndex: 8 });
    assert.deepEqual([full.status, full.body.code], [429, "LEASE_CAP"]);
    // ...but it no longer locks its own Kami for other renters.
    assert.equal((await h.post(RESERVE_PATH, { nonce: nonce(3), renter: renter(2), tokenIndex: 7 })).status, 201);
  } finally {
    await h.close();
  }
});
