import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLeaseAlerter } from "./renter-pod-alerts.mjs";
import { hardeningConfigFromEnv } from "./renter-pod-config.mjs";
import { claimOperatorReservation } from "./renter-pod-keys.mjs";
import { journalFileFor, openQuoteStore, readQuoteStore } from "./renter-pod-quote-store.mjs";
import { ATTEST_PATH, RELEASE_PATH, RESERVE_PATH, createReservationHandler } from "./renter-pod-reservation-server.mjs";
import { pruneReservations, reservationStats } from "./renter-pod-reservations.mjs";

const TOKEN = "t".repeat(40);
const MARKET = "0x00000000000000000000000000000000000000aa";
const FACTORY = "0x00000000000000000000000000000000000000bb";
const DIGEST = `0x${"cd".repeat(32)}`;
const nonce = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const renter = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const T0 = 1_790_000_000_000;
const MIN = 60_000;
// Every harness renter is funded unless a test passes its own balance reader.
const RICH = 10n ** 30n;
// Attest quotes carry the gas totals the keeper signs (REQUIRE_RENTER_BALANCE).
const GAS = { setupGasWei: "1000", hubGasWei: "2000", operatingGasWei: "3000" };
const job = (tokenIndex, who) => ({ tokenIndex, renter: who, returned: false });

/** In-process request/response pair (no sockets): fast enough for hour-long simulations. */
async function invoke(handler, { method = "POST", url, headers = {}, body, onHead }) {
  const payload = body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  const request = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk;
    },
  };
  const response = {
    status: null,
    headers: null,
    body: null,
    headersSent: false,
    writeHead(status, head) {
      onHead?.(status);
      this.status = status;
      this.headers = head;
      this.headersSent = true;
    },
    end(text) {
      this.body = JSON.parse(text);
    },
  };
  await handler(request, response);
  return { status: response.status, body: response.body, retryAfter: response.headers?.["Retry-After"] ?? null };
}

/**
 * store: "memory" records persist() calls; "disk" uses the real quote store
 * (append + fsync) in a temp dir. `fsImpl` lets a test make fsync a no-op for
 * long simulations (file sizes stay real).
 */
function harness({
  env = {},
  jobs = {},
  ingestRetry = {},
  listingExists,
  renterBalance = async () => RICH,
  store = "memory",
  fsImpl = fs,
  persistHook,
  signHook,
  startMs = T0,
} = {}) {
  const state = { jobs, reservations: {}, ingestRetry };
  const events = [];
  const alertLines = [];
  const balanceReads = [];
  let clock = startMs;
  let health = { ok: true, reason: "ok" };
  let dir = null;
  let quoteStore = null;
  let file = null;
  if (store === "disk") {
    dir = mkdtempSync(join(tmpdir(), "rp-res-srv-"));
    file = join(dir, "state.reservations.json");
    quoteStore = openQuoteStore({ file, getReservations: () => state.reservations, fs: fsImpl });
    state.reservations = quoteStore.load().reservations;
    quoteStore.compact();
  }
  const handler = createReservationHandler({
    state,
    token: TOKEN,
    market: MARKET,
    factory: FACTORY,
    policy: hardeningConfigFromEnv(env),
    health: () => health,
    quoteDigest: async () => DIGEST,
    signDigest: (digest) => {
      signHook?.(digest);
      events.push(["sign", digest]);
      return `sig(${digest})`;
    },
    persist: (nonces) => {
      persistHook?.(nonces);
      if (quoteStore) quoteStore.sync(nonces);
      events.push(["persist", nonces]);
    },
    alert: createLeaseAlerter({ log: (line) => alertLines.push(line), minIntervalMs: 60_000, now: () => clock }),
    log: () => {},
    now: () => clock,
    ...(listingExists ? { listingExists } : {}),
    renterBalance: async (who) => {
      balanceReads.push(who);
      return renterBalance(who);
    },
  });
  const call = (path, body, { auth = `Bearer ${TOKEN}`, method, onHead } = {}) => {
    const payload = path === ATTEST_PATH && body?.quote ? { ...body, quote: { ...GAS, ...body.quote } } : body;
    return invoke(handler, {
      method,
      url: path,
      headers: auth ? { authorization: auth } : {},
      body: { market: MARKET, factory: FACTORY, ...payload },
      onHead,
    });
  };
  const deadline = (aheadSec = 900) => String(Math.floor(clock / 1000) + aheadSec);
  /** reserve -> attest, the web's two worker calls for one checkout. */
  const checkout = async (n, who, tokenIndex, { fundingWei, deadlineSec } = {}) => {
    const reserved = await call(RESERVE_PATH, { nonce: nonce(n), renter: who, tokenIndex, ...(fundingWei !== undefined ? { fundingWei } : {}) });
    if (reserved.status !== 201) return { ...reserved, stage: "reserve" };
    const attested = await call(ATTEST_PATH, {
      quote: { nonce: nonce(n), renter: who, operator: reserved.body.operator, tokenIndex, deadline: deadlineSec ?? deadline() },
    });
    return { ...attested, stage: "attest", operator: reserved.body.operator };
  };
  return {
    state,
    events,
    alertLines,
    balanceReads,
    call,
    checkout,
    deadline,
    file,
    quoteStore,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    setHealth: (value) => {
      health = value;
    },
    close: () => {
      quoteStore?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("reserve: 201 with a fresh random operator that is on disk BEFORE the answer; a retry returns the same one", async () => {
  const h = harness({ store: "disk" });
  try {
    let durableAtAnswer = null;
    const result = await h.call(
      RESERVE_PATH,
      { nonce: nonce(1), renter: renter(1), tokenIndex: 7 },
      { onHead: () => (durableAtAnswer = readQuoteStore(h.file).reservations[nonce(1)] ?? null) }
    );
    assert.equal(result.status, 201);
    assert.match(result.body.operator, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(durableAtAnswer?.operator, result.body.operator, "key durable before the operator left the worker");
    assert.equal(durableAtAnswer.renter, renter(1));
    assert.equal(durableAtAnswer.tokenIndex, 7);
    const persists = h.events.filter(([kind]) => kind === "persist").length;
    const again = await h.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 7 });
    assert.equal(again.body.operator, result.body.operator);
    assert.equal(h.events.filter(([kind]) => kind === "persist").length, persists, "an idempotent retry writes nothing");
    const other = await h.call(RESERVE_PATH, { nonce: nonce(2), renter: renter(1) });
    assert.notEqual(other.body.operator, result.body.operator, "independent random keys per quote");
    assert.notEqual(h.state.reservations[nonce(1)].operatorKey, h.state.reservations[nonce(2)].operatorKey);
    assert.equal(statSync(h.file).mode & 0o777, 0o600);
    assert.equal(statSync(journalFileFor(h.file)).mode & 0o777, 0o600);
  } finally {
    h.close();
  }
});

test("request validation: 401 token, 404 route, 400 renter / nonce / market / tokenIndex / fundingWei / nonce reuse", async () => {
  const h = harness();
  try {
    assert.equal((await h.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(1) }, { auth: "Bearer nope" })).status, 401);
    assert.equal((await h.call("/v1/other", {})).status, 404);
    assert.equal((await h.call(RESERVE_PATH, {}, { method: "GET" })).status, 404);
    const missing = await h.call(RESERVE_PATH, { nonce: nonce(1) });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /renter/);
    assert.equal((await h.call(RESERVE_PATH, { nonce: "0x12", renter: renter(1) })).status, 400);
    assert.equal((await h.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), market: FACTORY })).status, 400);
    assert.equal((await h.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: "x" })).status, 400);
    assert.equal((await h.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), fundingWei: "0x10" })).status, 400);
    assert.equal(h.balanceReads.length, 0, "invalid requests never cost an RPC");
    assert.equal(Object.keys(h.state.reservations).length, 0, "nor a key");
    assert.equal((await h.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 4 })).status, 201);
    assert.match((await h.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(2) })).body.error, /different renter/);
    assert.match((await h.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 5 })).body.error, /different listing/);
  } finally {
    h.close();
  }
});

test("503 on reserve and attest while the worker is stale or halted; release is still answered", async () => {
  const h = harness();
  try {
    h.setHealth({ ok: false, reason: "halted" });
    const reserve = await h.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(1) });
    assert.deepEqual([reserve.status, reserve.body.reason, reserve.retryAfter], [503, "halted", "60"]);
    assert.equal((await h.call(ATTEST_PATH, { quote: { nonce: nonce(1), renter: renter(1) } })).status, 503);
    assert.deepEqual((await h.call(RELEASE_PATH, { nonce: nonce(1), renter: renter(1) })).body, { released: false });
    assert.equal(h.events.length, 0);
    h.setHealth({ ok: true, reason: "ok" });
    assert.equal((await h.checkout(1, renter(1), 4)).status, 200);
  } finally {
    h.close();
  }
});

test("optional allowlist (off by default): 403 at reserve and at attest when set", async () => {
  const h = harness({ env: { RENTER_ALLOWLIST: renter(1) } });
  try {
    assert.equal((await h.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(2) })).status, 403);
    const ok = await h.checkout(2, renter(1), 4);
    assert.equal(ok.status, 200);
  } finally {
    h.close();
  }
  const open = harness();
  try {
    assert.equal((await open.checkout(1, renter(99), 4)).status, 200, "no allowlist: any funded renter");
  } finally {
    open.close();
  }
});

test("caps count ON-CHAIN leases only: LEASE_CAP scope market / RESERVATION_CAP scope renter, no Retry-After, one alert line", async () => {
  const h = harness({ env: { MAX_ACTIVE_LEASES: "2" }, jobs: { 1: job(1, renter(1)) }, ingestRetry: { e: { tokenIndex: 2, renter: renter(1) } } });
  try {
    const market = await h.checkout(1, renter(5), 9);
    assert.deepEqual([market.stage, market.status, market.body.code, market.body.scope, market.retryAfter], ["reserve", 429, "LEASE_CAP", "market", null]);
    assert.equal((await h.checkout(2, renter(5), 2)).status, 200, "a Kami that already has an on-chain lease never trips the cap");
    h.state.jobs[1].returned = true;
    const mine = await h.checkout(3, renter(1), 9);
    assert.equal(mine.status, 200, "a returned lease frees both caps");
    h.state.jobs[9] = job(9, renter(1));
    const renterCap = await h.checkout(4, renter(1), 10);
    assert.deepEqual([renterCap.status, renterCap.body.code, renterCap.body.scope], [429, "LEASE_CAP", "market"]);
    const perRenter = harness({ jobs: { 1: job(1, renter(1)), 2: job(2, renter(1)) } });
    try {
      for (let i = 0; i < 3; i++) {
        const refused = await perRenter.checkout(10 + i, renter(1), 30 + i);
        assert.deepEqual([refused.status, refused.body.code, refused.body.scope], [429, "RESERVATION_CAP", "renter"]);
      }
      assert.equal(perRenter.alertLines.filter((line) => line.includes("RESERVATION_CAP")).length, 1, "rate-limited");
      assert.equal((await perRenter.checkout(20, renter(2), 30)).status, 200);
    } finally {
      perRenter.close();
    }
  } finally {
    h.close();
  }
});

test("concurrent checkouts at cap - 1 are ALL signed (overshoot bounded by listings); the cap binds once pods exist", async () => {
  const h = harness({ env: { MAX_ACTIVE_LEASES: "3" }, jobs: { 1: job(1, renter(1)), 2: job(2, renter(2)) } });
  try {
    const results = await Promise.all([10, 11, 12, 13].map((token, i) => h.checkout(100 + i, renter(20 + i), token)));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200]);
    for (const token of [10, 11]) h.state.jobs[token] = job(token, renter(30));
    assert.equal((await h.checkout(200, renter(40), 14)).body.code, "LEASE_CAP");
  } finally {
    h.close();
  }
});

test("attest: signs only the stored operator for the nonce, a real listing, a bounded deadline; binding durable before the signature", async () => {
  let durableAtSign = null;
  const h = harness({
    store: "disk",
    listingExists: async (token) => token !== 666,
    signHook: () => (durableAtSign = readQuoteStore(h.file).reservations[nonce(1)] ?? null),
  });
  try {
    const reserved = await h.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 4 });
    const quote = { nonce: nonce(1), renter: renter(1), operator: reserved.body.operator, tokenIndex: 4, deadline: h.deadline() };
    assert.match((await h.call(ATTEST_PATH, { quote: { ...quote, nonce: nonce(9) } })).body.error, /stored reservation/);
    assert.match((await h.call(ATTEST_PATH, { quote: { ...quote, operator: renter(77) } })).body.error, /operator reserved/);
    assert.match((await h.call(ATTEST_PATH, { quote: { ...quote, renter: renter(2) } })).body.error, /renter does not match/);
    assert.match((await h.call(ATTEST_PATH, { quote: { ...quote, tokenIndex: 5 } })).body.error, /tokenIndex does not match/);
    assert.match((await h.call(ATTEST_PATH, { quote: { ...quote, tokenIndex: undefined } })).body.error, /tokenIndex required/);
    assert.match((await h.call(ATTEST_PATH, { quote: { ...quote, deadline: h.deadline(-1) } })).body.error, /already passed/);
    assert.match((await h.call(ATTEST_PATH, { quote: { ...quote, deadline: h.deadline(3600) } })).body.error, /further ahead/);
    assert.match((await h.call(ATTEST_PATH, { quote: { ...quote, deadline: undefined } })).body.error, /deadline required/);
    assert.equal(h.events.filter(([kind]) => kind === "sign").length, 0, "nothing signed so far");

    const signed = await h.call(ATTEST_PATH, { quote });
    assert.deepEqual([signed.status, signed.body.keeperSignature], [200, `sig(${DIGEST})`]);
    assert.equal(durableAtSign?.attestedDigest, DIGEST, "binding on disk when the keeper signed");
    assert.equal(durableAtSign.quoteDeadline, Number(quote.deadline));
    assert.equal(durableAtSign.operator, reserved.body.operator);
    assert.equal((await h.call(ATTEST_PATH, { quote })).status, 200, "an identical retry re-signs the same quote");

    const fake = await h.call(RESERVE_PATH, { nonce: nonce(2), renter: renter(1) });
    const unknownListing = await h.call(ATTEST_PATH, { quote: { ...quote, nonce: nonce(2), operator: fake.body.operator, tokenIndex: 666 } });
    assert.match(unknownListing.body.error, /unknown listing/);
  } finally {
    h.close();
  }
});

test("attest: an unattested reservation past its TTL is never signed", async () => {
  const h = harness();
  try {
    const reserved = await h.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 4 });
    h.advance(20 * MIN + 1);
    const late = await h.call(ATTEST_PATH, { quote: { nonce: nonce(1), renter: renter(1), operator: reserved.body.operator, tokenIndex: 4, deadline: h.deadline() } });
    assert.match(late.body.error, /expired before attestation/);
  } finally {
    h.close();
  }
});

test("balance filter: unfunded reserve refused BEFORE any key exists; unfunded attest deletes the unsigned key; RPC failure fails closed", async () => {
  const balances = new Map([[renter(1), 0n], [renter(2), 6_000n]]);
  const h = harness({ renterBalance: async (who) => balances.get(who) ?? RICH });
  try {
    const poor = await h.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 4, fundingWei: "6000" });
    assert.deepEqual([poor.status, poor.body.code, poor.body.scope, poor.body.requiredWei], [403, "INSUFFICIENT_BALANCE", "renter", "6000"]);
    assert.equal(h.state.reservations[nonce(1)], undefined, "no key generated for an unfunded wallet");
    assert.equal((await h.checkout(2, renter(2), 4, { fundingWei: "6000" })).status, 200, "exactly funded");

    // Reserved without fundingWei, then the attest finds the wallet unfunded.
    const reserved = await h.call(RESERVE_PATH, { nonce: nonce(3), renter: renter(1), tokenIndex: 5 });
    const refused = await h.call(ATTEST_PATH, { quote: { nonce: nonce(3), renter: renter(1), operator: reserved.body.operator, tokenIndex: 5, deadline: h.deadline() } });
    assert.deepEqual([refused.status, refused.body.code], [403, "INSUFFICIENT_BALANCE"]);
    assert.equal(h.state.reservations[nonce(3)], undefined, "never signed: key dropped at once");
    assert.equal(h.events.filter(([kind]) => kind === "sign").length, 1);

    const capped = harness({ env: { MAX_ACTIVE_LEASES: "1" }, jobs: { 1: job(1, renter(9)) } });
    try {
      assert.equal((await capped.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 4, fundingWei: "1" })).status, 429);
      assert.equal(capped.balanceReads.length, 0, "a capped request never reads a balance");
    } finally {
      capped.close();
    }
  } finally {
    h.close();
  }
  const down = harness({ renterBalance: async () => {
    throw new Error("rpc down");
  } });
  try {
    const reserve = await down.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), fundingWei: "1" });
    assert.deepEqual([reserve.status, reserve.body.code, reserve.retryAfter], [503, "BALANCE_UNAVAILABLE", "60"]);
    const reserved = await down.call(RESERVE_PATH, { nonce: nonce(2), renter: renter(1), tokenIndex: 4 });
    const attest = await down.call(ATTEST_PATH, { quote: { nonce: nonce(2), renter: renter(1), operator: reserved.body.operator, tokenIndex: 4, deadline: down.deadline() } });
    assert.deepEqual([attest.status, attest.body.code], [503, "BALANCE_UNAVAILABLE"]);
    assert.equal(down.events.filter(([kind]) => kind === "sign").length, 0);
  } finally {
    down.close();
  }
  const off = harness({ env: { REQUIRE_RENTER_BALANCE: "off" }, renterBalance: async () => 0n });
  try {
    const result = await off.call(ATTEST_PATH, { quote: { nonce: nonce(1) } });
    assert.equal(result.status, 400);
    assert.equal((await off.checkout(2, renter(1), 4, { fundingWei: "1" })).status, 200);
    assert.equal(off.balanceReads.length, 0);
  } finally {
    off.close();
  }
});

test("release: renter-bound, idempotent, answered while halted; unsigned keys deleted, signed keys kept and never re-signed", async () => {
  const h = harness({ store: "disk" });
  try {
    const open = await h.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 4 });
    assert.equal((await h.call(RELEASE_PATH, { nonce: nonce(1), renter: renter(2) })).status, 400);
    h.setHealth({ ok: false, reason: "halted" });
    assert.deepEqual((await h.call(RELEASE_PATH, { nonce: nonce(1), renter: renter(1) })).body, { released: true });
    h.setHealth({ ok: true, reason: "ok" });
    assert.equal(readQuoteStore(h.file).reservations[nonce(1)], undefined, "unsigned key deleted on disk too");
    assert.deepEqual((await h.call(RELEASE_PATH, { nonce: nonce(1), renter: renter(1) })).body, { released: false });
    const late = await h.call(ATTEST_PATH, { quote: { nonce: nonce(1), renter: renter(1), operator: open.body.operator, tokenIndex: 4, deadline: h.deadline() } });
    assert.equal(late.status, 400, "a released nonce is dead");

    const signed = await h.checkout(2, renter(1), 5);
    assert.equal(signed.status, 200);
    assert.deepEqual((await h.call(RELEASE_PATH, { nonce: nonce(2), renter: renter(1) })).body, { released: true });
    const kept = readQuoteStore(h.file).reservations[nonce(2)];
    assert.equal(kept.attestedDigest, DIGEST, "the signed quote can still be submitted: its key stays");
    assert.ok(kept.releasedAt > 0);
    const again = await h.call(ATTEST_PATH, { quote: { nonce: nonce(2), renter: renter(1), operator: signed.operator, tokenIndex: 5, deadline: h.deadline() } });
    assert.match(again.body.error, /released/);
    assert.match((await h.call(RESERVE_PATH, { nonce: nonce(2), renter: renter(1) })).body.error, /released/);
  } finally {
    h.close();
  }
});

// --- Crash / durability ordering -------------------------------------------

test("CRASH: a key-store failure at reserve returns 503 KEY_STORE_UNAVAILABLE and hands out no operator", async () => {
  let fail = true;
  const h = harness({ persistHook: () => {
    if (fail) throw new Error("EIO");
  } });
  try {
    const result = await h.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 4 });
    assert.deepEqual([result.status, result.body.code, result.body.operator, result.retryAfter], [503, "KEY_STORE_UNAVAILABLE", undefined, "60"]);
    assert.equal(h.state.reservations[nonce(1)], undefined, "an operator never handed out is not kept");
    fail = false;
    assert.equal((await h.checkout(1, renter(1), 4)).status, 200, "a retry succeeds once the disk is back");
  } finally {
    h.close();
  }
});

test("CRASH: a key-store failure at attest signs NOTHING and rolls the binding back", async () => {
  let fail = false;
  const h = harness({ persistHook: () => {
    if (fail) throw new Error("ENOSPC");
  } });
  try {
    const reserved = await h.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 4 });
    fail = true;
    const quote = { nonce: nonce(1), renter: renter(1), operator: reserved.body.operator, tokenIndex: 4, deadline: h.deadline() };
    const result = await h.call(ATTEST_PATH, { quote });
    assert.deepEqual([result.status, result.body.code, result.body.keeperSignature], [503, "KEY_STORE_UNAVAILABLE", undefined]);
    assert.equal(h.events.filter(([kind]) => kind === "sign").length, 0);
    assert.equal(h.state.reservations[nonce(1)].attestedDigest, undefined, "binding rolled back");
    assert.equal(h.state.reservations[nonce(1)].quoteDeadline, undefined);
    fail = false;
    assert.equal((await h.call(ATTEST_PATH, { quote })).status, 200);
  } finally {
    h.close();
  }
});

test("CRASH between persist and sign: the process dies after the fsync; on restart the key + binding are on disk and the pod is adoptable", async () => {
  const h = harness({ store: "disk", signHook: () => {
    throw new Error("SIGKILL (simulated) right after the binding was fsync'd");
  } });
  try {
    const reserved = await h.call(RESERVE_PATH, { nonce: nonce(1), renter: renter(1), tokenIndex: 4 });
    const quote = { nonce: nonce(1), renter: renter(1), operator: reserved.body.operator, tokenIndex: 4, deadline: h.deadline() };
    const result = await h.call(ATTEST_PATH, { quote });
    assert.equal(result.body.keeperSignature, undefined, "no signature left the worker");
    // Restart from disk only (the in-memory state died with the process).
    const restarted = { jobs: {}, reservations: readQuoteStore(h.file).reservations };
    const entry = restarted.reservations[nonce(1)];
    assert.deepEqual([entry.operator, entry.attestedDigest, entry.quoteDeadline], [reserved.body.operator, DIGEST, Number(quote.deadline)]);
    // Had the signature escaped anyway, the pod's RenterPodCreated would find its key.
    assert.equal(claimOperatorReservation(restarted, nonce(1), reserved.body.operator, { remove: false }), entry.operatorKey);
    // The pruner keeps it until ingest proves the deadline passed on-chain.
    assert.deepEqual(pruneReservations(restarted, { nowMs: h.now() + 60 * MIN, ttlMs: 20 * MIN, ingestedThroughSec: Number(quote.deadline) }), []);
  } finally {
    h.close();
  }
});

// --- Jam simulations (the review PoCs against the retired design) ----------

test("JAM (a): 20 funded throwaway wallets quoting EVERY listing every 14 min for 4 h (and releasing) never block an honest renter", async () => {
  const h = harness({ env: { MAX_ACTIVE_LEASES: "20" } });
  try {
    const LISTINGS = 30;
    let n = 0;
    let attackerSigned = 0;
    let honestSigned = 0;
    let honestRefused = 0;
    let previous = [];
    for (let minute = 0; minute < 240; minute++) {
      if (minute % 14 === 0) {
        const current = [];
        for (let wallet = 0; wallet < 20; wallet++) {
          for (let token = 0; token < LISTINGS; token++) {
            const result = await h.checkout(++n, renter(1_000 + wallet), token);
            if (result.status === 200) attackerSigned++;
            current.push([n, renter(1_000 + wallet)]);
          }
        }
        for (const [old, who] of previous) await h.call(RELEASE_PATH, { nonce: nonce(old), renter: who });
        previous = current;
      }
      if (minute % 5 === 0) {
        const result = await h.checkout(++n, renter(7), minute % LISTINGS);
        if (result.status === 200) honestSigned++;
        else honestRefused++;
        // The honest renter declines (closes checkout) every time: still never locked out.
        await h.call(RELEASE_PATH, { nonce: nonce(n), renter: renter(7) });
      }
      h.advance(MIN);
      pruneReservations(h.state, { nowMs: h.now(), ttlMs: 20 * MIN, ingestedThroughSec: Math.floor(h.now() / 1000) - 20 });
    }
    assert.equal(honestRefused, 0);
    assert.equal(honestSigned, 48);
    assert.equal(attackerSigned, 18 * 20 * LISTINGS, "the attacker gets quotes too - they just hold nothing");
    // What bounds the attacker is on-chain: only submitted, funded checkouts count.
    assert.equal(h.state.jobs && Object.keys(h.state.jobs).length, 0);
  } finally {
    h.close();
  }
});

test("JAM (b): zero-ETH wallets hammering one Kami are refused before a key exists and never affect anyone else", async () => {
  const h = harness({ renterBalance: async (who) => (who === renter(7) ? RICH : 0n) });
  try {
    for (let i = 0; i < 500; i++) {
      const result = await h.checkout(i + 1, renter(10_000 + i), 4, { fundingWei: "6000" });
      assert.equal(result.status, 403);
    }
    assert.equal(Object.keys(h.state.reservations).length, 0, "no key, no store growth");
    assert.equal(h.events.length, 0, "no disk write at all");
    assert.equal((await h.checkout(1_000, renter(7), 4, { fundingWei: "6000" })).status, 200);
  } finally {
    h.close();
  }
});

test("JAM (c): quote volume cannot fill the market; only on-chain pods can, and contention for one Kami resolves on-chain", async () => {
  const h = harness({ env: { MAX_ACTIVE_LEASES: "2" } });
  try {
    for (let i = 0; i < 300; i++) assert.equal((await h.checkout(i + 1, renter(2_000 + i), i % 5)).status, 200);
    // Two renters raced for Kami #3 and both hold signed quotes; the chain
    // accepts the first create and reverts the second (the web simulates it and
    // shows "this Kami was just rented"). The worker only ever sees the winner.
    h.state.jobs[3] = job(3, renter(2_003));
    assert.equal((await h.checkout(900, renter(8), 3)).status, 200, "Kami #3's slot is already counted");
    h.state.jobs[4] = job(4, renter(2_004));
    assert.equal((await h.checkout(901, renter(8), 1)).body.code, "LEASE_CAP", "two real pods fill a cap of 2");
  } finally {
    h.close();
  }
});

test("BURST: 50 IPs at the web's per-IP limit (12/min) for 1 h - every quote signed, no key ever refused or evicted, store bounded", { timeout: 300_000 }, async () => {
  // fsync is a no-op here to keep the test fast; sizes and counts are real.
  // Measured fsync cost: bench-quote-store-burst.mjs.
  const quick = { ...fs, fsyncSync: () => {} };
  const h = harness({ store: "disk", fsImpl: quick });
  try {
    const PER_MINUTE = 50 * 12;
    const WALLETS = 2_000; // web per-renter limit 6/min -> at least 100 wallets needed
    let n = 0;
    let maxEntries = 0;
    let maxJournal = 0;
    let maxSnapshot = 0;
    const signedNonces = [];
    for (let second = 0; second < 3_600; second++) {
      for (let i = 0; i < PER_MINUTE / 60; i++) {
        n++;
        const result = await h.checkout(n, renter(50_000 + (n % WALLETS)), n % 5_000);
        assert.equal(result.status, 200, `quote ${n} refused: ${JSON.stringify(result.body)}`);
        signedNonces.push([n, h.now()]);
      }
      h.advance(1_000);
      if (second % 30 === 29) {
        // Worker tick: ingest has covered chain time up to ~20 s ago.
        pruneReservations(h.state, { nowMs: h.now(), ttlMs: 20 * MIN, ingestedThroughSec: Math.floor(h.now() / 1000) - 20 });
        h.quoteStore.maybeCompact();
        const entries = Object.keys(h.state.reservations).length;
        maxEntries = Math.max(maxEntries, entries);
        maxJournal = Math.max(maxJournal, statSync(journalFileFor(h.file)).size);
        maxSnapshot = Math.max(maxSnapshot, statSync(h.file).size);
        // Never evicted early: every signed quote younger than its deadline + ingest lag is still stored.
        for (let k = signedNonces.length - 1; k >= 0 && h.now() - signedNonces[k][1] < 15 * MIN; k -= 97) {
          assert.ok(h.state.reservations[nonce(signedNonces[k][0])], `key of quote ${signedNonces[k][0]} evicted early`);
        }
      }
    }
    assert.equal(n, 36_000);
    // Live keys = rate x (deadline 15 min + ingest lag + prune period) ~ 600 x 15.8.
    assert.ok(maxEntries <= PER_MINUTE * 16 + PER_MINUTE, `maxEntries=${maxEntries}`);
    assert.ok(maxEntries >= PER_MINUTE * 15, `maxEntries=${maxEntries}`);
    assert.ok(maxSnapshot < 6 * 1024 * 1024, `snapshot ${maxSnapshot} B`);
    assert.ok(maxJournal < 3 * maxSnapshot + 2 * 1024 * 1024, `journal ${maxJournal} B`);
    // After the burst the store drains on its own.
    h.advance(16 * MIN);
    pruneReservations(h.state, { nowMs: h.now(), ttlMs: 20 * MIN, ingestedThroughSec: Math.floor(h.now() / 1000) - 20 });
    assert.equal(Object.keys(h.state.reservations).length, 0);
    assert.equal(reservationStats(h.state, { nowMs: h.now(), ttlMs: 20 * MIN }).total, 0);
    console.log(`burst: 36000 quotes, max live keys ${maxEntries}, max snapshot ${maxSnapshot} B, max journal ${maxJournal} B, compactions ${h.quoteStore.stats().compactions}`);
  } finally {
    h.close();
  }
});
