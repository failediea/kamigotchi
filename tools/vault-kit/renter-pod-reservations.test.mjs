import assert from "node:assert/strict";
import test from "node:test";
import { hardeningConfigFromEnv } from "./renter-pod-config.mjs";
import { claimOperatorReservation, reserveRandomOperator } from "./renter-pod-keys.mjs";
import {
  QUOTE_DEADLINE_SKEW_SEC,
  RefusalScope,
  admitQuote,
  mergeStoredReservations,
  onChainLeases,
  parseWei,
  prunableReservations,
  pruneReservations,
  quoteDeadlineAdmission,
  quoteFundingWei,
  releaseReservation,
  renterBalanceAdmission,
  reservationFileFor,
  reservationStats,
  stateForDisk,
} from "./renter-pod-reservations.mjs";

const nonce = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const renter = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const policy = (env = {}) => hardeningConfigFromEnv(env);
const MIN = 60_000;
const DIGEST = `0x${"11".repeat(32)}`;

function withReservations(count, { renterOf = () => renter(1), createdAt = 0 } = {}) {
  const state = { jobs: {}, reservations: {} };
  for (let i = 0; i < count; i++) reserveRandomOperator(state, nonce(i + 1), { now: createdAt, renter: renterOf(i) });
  return state;
}

const job = (tokenIndex, who, extra = {}) => ({ tokenIndex, renter: who, returned: false, ...extra });

test("renter address is required and allowlist refusals are 403", () => {
  const state = { jobs: {}, reservations: {} };
  assert.equal(admitQuote(state, { renter: "nope", policy: policy() }).status, 400);
  const gated = policy({ RENTER_ALLOWLIST: `${renter(1)}, ${renter(2).toUpperCase().replace("0X", "0x")}` });
  assert.equal(admitQuote(state, { renter: renter(3), policy: gated }).status, 403);
  assert.equal(admitQuote(state, { renter: renter(2), policy: gated }).ok, true);
  assert.equal(admitQuote(state, { renter: renter(1), policy: policy() }).ok, true, "no allowlist by default");
});

test("tokenIndex: optional at reserve, required at attest, uint32 only", () => {
  const state = { jobs: {}, reservations: {} };
  assert.equal(admitQuote(state, { renter: renter(1), policy: policy() }).tokenIndex, null);
  assert.equal(admitQuote(state, { renter: renter(1), tokenIndex: "7", policy: policy() }).tokenIndex, 7);
  assert.equal(admitQuote(state, { renter: renter(1), tokenIndex: "x", policy: policy() }).status, 400);
  assert.equal(admitQuote(state, { renter: renter(1), tokenIndex: 2 ** 32, policy: policy() }).status, 400);
  assert.match(admitQuote(state, { renter: renter(1), requireTokenIndex: true, policy: policy() }).error, /tokenIndex required/);
});

test("on-chain leases: unreturned jobs + parked on-chain events, distinct per Kami; returned jobs and quotes never count", () => {
  const state = withReservations(50, { renterOf: (i) => renter(500 + i) });
  for (const entry of Object.values(state.reservations)) {
    entry.attestedDigest = DIGEST;
    entry.quoteDeadline = 10_000;
    entry.tokenIndex = 99;
  }
  state.jobs = { 1: job(1, renter(1)), 2: job(2, renter(1), { returned: true }), 3: job(3, renter(2)) };
  state.ingestRetry = { "e:1": { tokenIndex: 4, renter: renter(1) }, "e:2": { tokenIndex: 3, renter: renter(2) } };
  const leases = onChainLeases(state);
  assert.deepEqual([...leases.activeTokens].sort(), [1, 3, 4]);
  assert.deepEqual([...leases.perRenter.get(renter(1))].sort(), [1, 4]);
  assert.deepEqual([...leases.perRenter.get(renter(2))], [3], "a parked event for an adopted Kami counts once");
  assert.equal(leases.activeTokens.has(99), false, "50 signed quotes count for nothing");
});

test("LEASE_CAP (scope market) counts on-chain leases only; a Kami that already has one never trips it", () => {
  const state = { jobs: { 1: job(1, renter(1)), 2: job(2, renter(2)) }, reservations: {} };
  const cap2 = policy({ MAX_ACTIVE_LEASES: "2" });
  const refused = admitQuote(state, { renter: renter(9), tokenIndex: 5, policy: cap2 });
  assert.deepEqual([refused.status, refused.code, refused.details.scope, refused.details.active], [429, "LEASE_CAP", RefusalScope.MARKET, 2]);
  assert.equal(admitQuote(state, { renter: renter(9), policy: cap2 }).code, "LEASE_CAP", "no tokenIndex: refused at cap");
  assert.equal(admitQuote(state, { renter: renter(9), tokenIndex: 2, policy: cap2 }).ok, true, "Kami #2 is counted already");
  assert.equal(admitQuote(state, { renter: renter(9), tokenIndex: 5, policy: policy({ MAX_ACTIVE_LEASES: "3" }) }).ok, true);
});

test("per-renter cap (scope renter, code RESERVATION_CAP) counts that renter's on-chain leases only", () => {
  const state = withReservations(10, { renterOf: () => renter(1) });
  for (const entry of Object.values(state.reservations)) {
    entry.attestedDigest = DIGEST;
    entry.quoteDeadline = 10_000;
  }
  assert.equal(admitQuote(state, { renter: renter(1), tokenIndex: 8, policy: policy() }).ok, true, "10 signed quotes hold nothing");
  state.jobs = { 1: job(1, renter(1)) };
  state.ingestRetry = { e: { tokenIndex: 2, renter: renter(1) } };
  const refused = admitQuote(state, { renter: renter(1), tokenIndex: 8, policy: policy() });
  assert.deepEqual([refused.status, refused.code, refused.details.scope, refused.details.leases], [429, "RESERVATION_CAP", "renter", 2]);
  assert.equal(admitQuote(state, { renter: renter(1), tokenIndex: 2, policy: policy() }).ok, true, "its own Kami counts once");
  assert.equal(admitQuote(state, { renter: renter(2), tokenIndex: 8, policy: policy() }).ok, true);
  state.jobs[1].returned = true;
  assert.equal(admitQuote(state, { renter: renter(1), tokenIndex: 8, policy: policy() }).ok, true, "a returned lease frees the slot");
});

test("quote funding: setupGasWei + hubGasWei + operatingGasWei, strict uint128 decimal parsing", () => {
  assert.equal(quoteFundingWei({ setupGasWei: "1", hubGasWei: 2, operatingGasWei: "3000000000000000000" }), 3_000_000_000_000_000_003n);
  for (const bad of [undefined, null, "", "0x10", "-1", "1.5", "1e3", " ", -1, 1.5, "340282366920938463463374607431768211456"]) {
    assert.equal(quoteFundingWei({ setupGasWei: bad, hubGasWei: "0", operatingGasWei: "0" }), null, JSON.stringify(bad));
  }
  assert.equal(parseWei("340282366920938463463374607431768211455"), 2n ** 128n - 1n);
  assert.equal(renterBalanceAdmission({ renter: renter(1), balanceWei: 10n, requiredWei: 10n }).ok, true);
  const refused = renterBalanceAdmission({ renter: renter(1), balanceWei: 9n, requiredWei: 10n });
  assert.deepEqual([refused.status, refused.code, refused.details.scope, refused.body], [403, "INSUFFICIENT_BALANCE", "renter", { requiredWei: "10" }]);
});

test("quote deadline: required, in the future, at most RESERVATION_TTL_SEC (+ skew) ahead", () => {
  const nowMs = 1_790_000_000_000;
  const nowSec = nowMs / 1000;
  const ttlMs = 20 * MIN;
  assert.deepEqual(quoteDeadlineAdmission(String(nowSec + 900), { nowMs, ttlMs }), { ok: true, deadline: nowSec + 900 });
  assert.equal(quoteDeadlineAdmission(nowSec + 1200 + QUOTE_DEADLINE_SKEW_SEC, { nowMs, ttlMs }).ok, true);
  assert.match(quoteDeadlineAdmission(nowSec + 1200 + QUOTE_DEADLINE_SKEW_SEC + 1, { nowMs, ttlMs }).error, /further ahead/);
  assert.match(quoteDeadlineAdmission(nowSec, { nowMs, ttlMs }).error, /already passed/);
  for (const bad of [undefined, null, "", "0", "-5", "1e9", "0x10", "12.5", {}]) {
    assert.equal(quoteDeadlineAdmission(bad, { nowMs, ttlMs }).status, 400, JSON.stringify(bad));
  }
});

test("release: unattested keys are deleted at once; attested keys are only marked; renter-bound and idempotent", () => {
  const state = withReservations(2);
  const second = state.reservations[nonce(2)];
  second.attestedDigest = DIGEST;
  second.quoteDeadline = 900;
  assert.equal(releaseReservation(state, { nonce: nonce(1), renter: renter(2), nowMs: 0 }).status, 400);
  assert.deepEqual(releaseReservation(state, { nonce: nonce(1), renter: renter(1), nowMs: 5 }), { ok: true, released: true, deleted: true });
  assert.equal(state.reservations[nonce(1)], undefined, "never signed: no pod can use it");
  assert.deepEqual(releaseReservation(state, { nonce: nonce(1), renter: renter(1), nowMs: 6 }), { ok: true, released: false });
  assert.deepEqual(releaseReservation(state, { nonce: nonce(2), renter: renter(1), nowMs: 7 }), { ok: true, released: true, deleted: false });
  assert.equal(state.reservations[nonce(2)].releasedAt, 7, "signed quote: the key stays until its deadline");
  assert.deepEqual(releaseReservation(state, { nonce: nonce(2), renter: renter(1), nowMs: 8 }), { ok: true, released: false });
  assert.equal(releaseReservation(state, { nonce: nonce(2), renter: "nope", nowMs: 8 }).status, 400);
});

test("prune: unattested keys go after the TTL even with ingest stalled; released attested keys are NOT pruned early", () => {
  const state = withReservations(3, { createdAt: 0 });
  const signed = state.reservations[nonce(3)];
  signed.attestedDigest = DIGEST;
  signed.quoteDeadline = 15 * 60;
  signed.releasedAt = 1;
  assert.deepEqual(pruneReservations(state, { nowMs: 19 * MIN, ttlMs: 20 * MIN, ingestedThroughSec: null }), []);
  assert.deepEqual(pruneReservations(state, { nowMs: 21 * MIN, ttlMs: 20 * MIN, ingestedThroughSec: null }).sort(), [nonce(1), nonce(2)]);
  assert.deepEqual(Object.keys(state.reservations), [nonce(3)]);
});

test("prune: an attested key survives until ingest has covered its quote deadline (chain time, not the local clock)", () => {
  const state = withReservations(1, { createdAt: 0 });
  const entry = state.reservations[nonce(1)];
  entry.attestedDigest = DIGEST;
  entry.quoteDeadline = 15 * 60; // seconds
  const args = { nowMs: 600 * MIN, ttlMs: 20 * MIN };
  assert.deepEqual(pruneReservations(state, { ...args, ingestedThroughSec: null }), [], "ingest stalled: keep the key");
  assert.deepEqual(pruneReservations(state, { ...args, ingestedThroughSec: 15 * 60 }), [], "deadline block not yet past");
  assert.deepEqual(pruneReservations(state, { ...args, ingestedThroughSec: 15 * 60 + 1 }), [nonce(1)]);
  // No TTL wait once the chain has passed the deadline.
  const fresh = withReservations(1, { createdAt: 0 });
  Object.assign(fresh.reservations[nonce(1)], { attestedDigest: DIGEST, quoteDeadline: 60 });
  assert.deepEqual(pruneReservations(fresh, { nowMs: 2 * MIN, ttlMs: 20 * MIN, ingestedThroughSec: 61 }), [nonce(1)]);
});

test("prune: legacy attested keys keep the old 24h rule; nonces parked for ingest retry are never pruned", () => {
  const state = withReservations(3, { createdAt: 0 });
  for (const entry of Object.values(state.reservations)) entry.attestedDigest = DIGEST;
  state.reservations[nonce(3)].quoteDeadline = 60;
  const day = 24 * 60 * MIN;
  assert.deepEqual(pruneReservations(state, { nowMs: day + 1, ttlMs: 20 * MIN, ingestedThroughSec: 30, protectedNonces: new Set([nonce(3)]) }), []);
  const removed = pruneReservations(state, {
    nowMs: day + 5_000,
    ttlMs: 20 * MIN,
    ingestedThroughSec: day / 1000 + 2,
    protectedNonces: new Set([nonce(2), nonce(3)]),
  });
  assert.deepEqual(removed, [nonce(1)]);
  assert.deepEqual(Object.keys(state.reservations).sort(), [nonce(2), nonce(3)]);
  assert.deepEqual(prunableReservations(state, { nowMs: day * 2, ttlMs: 20 * MIN, ingestedThroughSec: day * 2, protectedNonces: new Set([nonce(2), nonce(3)]) }), []);
});

test("prune never evicts for space: 20,000 unexpired signed quotes all keep their keys", () => {
  const state = { jobs: {}, reservations: {} };
  for (let i = 0; i < 20_000; i++) {
    state.reservations[nonce(i + 1)] = { operator: "0x", operatorKey: "0x", createdAt: 0, attestedDigest: DIGEST, quoteDeadline: 100_000 };
  }
  assert.deepEqual(pruneReservations(state, { nowMs: 10 * 60 * MIN, ttlMs: 20 * MIN, ingestedThroughSec: 99_999 }), []);
  assert.equal(Object.keys(state.reservations).length, 20_000);
  const stats = reservationStats(state, { nowMs: 10_000_000, ttlMs: 20 * MIN });
  assert.deepEqual([stats.total, stats.attested, stats.live], [20_000, 20_000, 20_000]);
});

test("reservationStats (heartbeat liveReservations) counts keys that can still become a pod; observability only", () => {
  const state = withReservations(4, { createdAt: 0 });
  Object.assign(state.reservations[nonce(1)], { attestedDigest: DIGEST, quoteDeadline: 100 });
  Object.assign(state.reservations[nonce(2)], { attestedDigest: DIGEST, quoteDeadline: 10 });
  state.reservations[nonce(3)].releasedAt = 1;
  const stats = reservationStats(state, { nowMs: 50_000, ttlMs: 20 * MIN });
  assert.deepEqual([stats.live, stats.attested, stats.total], [2, 2, 4]);
});

test("merge: legacy embedded reservations join the store; keeper bindings are never lost; conflicts surface", () => {
  const stored = withReservations(2).reservations;
  const signed = { ...stored[nonce(2)], attestedDigest: DIGEST, quoteDeadline: 900 };
  // The state file (older) has nonce 2 unattested plus a nonce only it knows.
  const state = withReservations(0);
  state.reservations = { [nonce(2).toUpperCase().replace("0X", "0x")]: { ...stored[nonce(2)] }, [nonce(7)]: { operator: "0x7", operatorKey: "k", createdAt: 1 } };
  state.listingCooldowns = { [`${renter(1)}:4`]: 123 };
  const { migrated } = mergeStoredReservations(state, { ...stored, [nonce(2)]: signed });
  assert.equal(migrated, 1);
  assert.equal(state.reservations[nonce(2)].attestedDigest, DIGEST, "the store's binding survives an unattested copy");
  assert.equal(state.reservations[nonce(7)].operator, "0x7");
  assert.equal("listingCooldowns" in state, false, "the retired design's cooldowns are dropped");
  const conflicting = withReservations(1);
  assert.throws(() => mergeStoredReservations(conflicting, stored), /reconcile by hand/);
});

test("stateForDisk: no operator keys of quotes in flight in the job state file; hardening containers only when non-empty", () => {
  const state = withReservations(3);
  Object.assign(state, { lastBlock: 1, retiredJobs: {}, ingestRetry: {}, pendingTxs: { k: {} }, txNonceHints: {}, listingCooldowns: { x: 1 } });
  const onDisk = stateForDisk(state);
  assert.deepEqual(onDisk, { lastBlock: 1, jobs: {}, pendingTxs: { k: {} }, reservations: {} });
  assert.equal(Object.keys(state.reservations).length, 3, "in-memory state is not mutated");
  assert.doesNotMatch(JSON.stringify(onDisk), /operatorKey/);
});

test("rollback: after the launch-ops merge (snapshot -> state file) a pre-hardening worker finds in-flight keys", () => {
  const live = withReservations(1);
  const operator = live.reservations[nonce(1)].operator;
  // launch-ops rollback step 3: merge the store snapshot into the state file.
  const rolledBack = JSON.parse(JSON.stringify(stateForDisk(live)));
  rolledBack.reservations = { ...rolledBack.reservations, ...JSON.parse(JSON.stringify(live.reservations)) };
  assert.equal(claimOperatorReservation(rolledBack, nonce(1), operator), live.reservations[nonce(1)].operatorKey);
});

test("reservation store path: next to the job state file, one per market", () => {
  assert.equal(reservationFileFor("/var/lib/x/musu-renter-pod-worker-state.json"), "/var/lib/x/musu-renter-pod-worker-state.reservations.json");
});
