import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hardeningConfigFromEnv } from "./renter-pod-config.mjs";
import { reserveRandomOperator } from "./renter-pod-keys.mjs";
import {
  ATTEST_PROVISIONAL_MS,
  RefusalScope,
  admitAttestation,
  admitReservation,
  holdAttestationSlot,
  leaseCapacity,
  renterLeaseLoad,
  loadReservationStore,
  pruneReservations,
  reservationFileFor,
  reservationStats,
  saveReservationStore,
  stateForDisk,
} from "./renter-pod-reservations.mjs";

const nonce = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const renter = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const policy = (env = {}) => hardeningConfigFromEnv(env);
const MIN = 60_000;

function withReservations(count, { renterOf = () => renter(1), createdAt = 0 } = {}) {
  const state = { jobs: {}, reservations: {} };
  for (let i = 0; i < count; i++) reserveRandomOperator(state, nonce(i + 1), { now: createdAt, renter: renterOf(i) });
  return state;
}

test("renter address is required and allowlist refusals are 403", () => {
  const state = { jobs: {}, reservations: {} };
  assert.equal(admitReservation(state, { renter: "nope", nonce: nonce(1), nowMs: 0, policy: policy() }).status, 400);
  const gated = policy({ RENTER_ALLOWLIST: `${renter(1)}, ${renter(2).toUpperCase().replace("0X", "0x")}` });
  assert.equal(admitReservation(state, { renter: renter(3), nonce: nonce(1), nowMs: 0, policy: gated }).status, 403);
  assert.equal(admitReservation(state, { renter: renter(2), nonce: nonce(1), nowMs: 0, policy: gated }).ok, true);
  assert.equal(admitReservation(state, { renter: renter(1), nonce: nonce(1), nowMs: 0, policy: policy() }).ok, true);
});

test("per-renter cap (default 2) is 429 RESERVATION_CAP", () => {
  const state = withReservations(2);
  const result = admitReservation(state, { renter: renter(1), nonce: nonce(99), nowMs: 0, policy: policy() });
  assert.equal(result.status, 429);
  assert.equal(result.code, "RESERVATION_CAP");
  assert.equal(result.details.scope, "reservation");
  assert.equal(admitReservation(state, { renter: renter(2), nonce: nonce(99), nowMs: 0, policy: policy() }).ok, true);
});

test("global live-reservation cap is 429 RESERVATION_CAP", () => {
  const state = withReservations(5, { renterOf: (i) => renter(100 + i) });
  const tight = policy({ MAX_LIVE_RESERVATIONS: "5", MAX_ACTIVE_LEASES: "100" });
  const result = admitReservation(state, { renter: renter(1), nonce: nonce(99), nowMs: 0, policy: tight });
  assert.equal(result.status, 429);
  assert.equal(result.code, "RESERVATION_CAP");
  assert.equal(result.details.scope, "market");
});

const attest = (state, n, { tokenIndex, deadlineSec = 15 * 60 } = {}) => {
  const entry = state.reservations[nonce(n)];
  entry.attestedDigest = `0x${n.toString(16).padStart(64, "0")}`;
  entry.quoteDeadline = deadlineSec;
  entry.tokenIndex = tokenIndex;
};

test("review repro: 20 unauthenticated reserve calls can no longer lock the market (LEASE_CAP)", () => {
  // Before: 20 reservations from random renters -> every renter got 429
  // LEASE_CAP for the next 20 minutes, renewable.
  const state = withReservations(20, { renterOf: (i) => renter(1_000 + i) });
  const real = admitReservation(state, { renter: renter(1), nonce: nonce(99), nowMs: 0, policy: policy() });
  assert.equal(real.ok, true, "unattested reservations never count toward the lease cap");
  reserveRandomOperator(state, nonce(99), { now: 0, renter: renter(1) });
  const attested = admitAttestation(state, state.reservations[nonce(99)], {
    quote: { renter: renter(1), tokenIndex: 7 },
    nowMs: 19 * MIN + 59_000,
    policy: policy(),
  });
  assert.equal(attested.ok, true);
});

test("lease cap counts active leases plus DISTINCT attested listings: 429 LEASE_CAP at attest", () => {
  const state = withReservations(4, { renterOf: (i) => renter(50 + i) });
  state.jobs = { 1: { tokenIndex: 1, returned: false }, 2: { tokenIndex: 2, returned: true }, 3: { tokenIndex: 3, returned: false } };
  attest(state, 1, { tokenIndex: 10 });
  attest(state, 2, { tokenIndex: 10 }); // same listing: counted once
  attest(state, 3, { tokenIndex: 3 }); // listing already active: not double counted
  const cap3 = policy({ MAX_ACTIVE_LEASES: "3" });
  const quote = (tokenIndex) => ({ renter: renter(53), tokenIndex });
  const refused = admitAttestation(state, state.reservations[nonce(4)], { quote: quote(11), nowMs: 0, policy: cap3 });
  assert.equal(refused.status, 429);
  assert.equal(refused.code, "LEASE_CAP");
  assert.deepEqual(refused.details, { scope: "market", active: 2, pending: 1, cap: 3 });
  // A quote for a listing that is already counted adds nothing, so it passes.
  assert.equal(admitAttestation(state, state.reservations[nonce(4)], { quote: quote(10), nowMs: 0, policy: cap3 }).ok, true);
  // Once the attested quotes' deadline has passed, they stop counting.
  assert.equal(admitAttestation(state, state.reservations[nonce(4)], { quote: quote(11), nowMs: 16 * MIN, policy: cap3 }).ok, true);
  // The reserve route answers LEASE_CAP early only from real leases + attested listings.
  const early = admitReservation(state, { renter: renter(9), nonce: nonce(98), tokenIndex: 11, nowMs: 0, policy: cap3 });
  assert.equal(early.code, "LEASE_CAP");
  assert.equal(admitReservation(state, { renter: renter(9), nonce: nonce(98), tokenIndex: 10, nowMs: 0, policy: cap3 }).ok, true);
  assert.equal(admitReservation(state, { renter: renter(9), nonce: nonce(98), nowMs: 0, policy: cap3 }).ok, true, "no tokenIndex: decided at attest");
});

test("attestation requires a valid quote tokenIndex matching the reservation", () => {
  const state = withReservations(1);
  const entry = state.reservations[nonce(1)];
  const args = (tokenIndex) => ({ quote: { renter: renter(1), tokenIndex }, nowMs: 0, policy: policy() });
  assert.equal(admitAttestation(state, entry, args(undefined)).status, 400);
  assert.equal(admitAttestation(state, entry, args(-1)).status, 400);
  assert.equal(admitAttestation(state, entry, args(2 ** 32)).status, 400);
  entry.tokenIndex = 5;
  assert.match(admitAttestation(state, entry, args(6)).error, /does not match/);
  assert.equal(admitAttestation(state, entry, args("5")).tokenIndex, 5);
});

test("optional per-listing reservation cap (off by default) applies when tokenIndex is sent", () => {
  const state = withReservations(2, { renterOf: (i) => renter(70 + i) });
  for (const entry of Object.values(state.reservations)) entry.tokenIndex = 4;
  const args = (env) => ({ renter: renter(1), nonce: nonce(99), tokenIndex: 4, nowMs: 0, policy: policy(env) });
  assert.equal(admitReservation(state, args({})).ok, true, "off by default");
  const refused = admitReservation(state, args({ MAX_RESERVATIONS_PER_LISTING: "2" }));
  assert.equal(refused.code, "RESERVATION_CAP");
  assert.equal(refused.details.scope, "lease");
  assert.equal(admitReservation(state, { ...args({}), tokenIndex: "x" }).status, 400);
});

test("expired reservations stop counting toward caps", () => {
  const state = withReservations(2, { createdAt: 0 });
  const later = 21 * MIN;
  assert.equal(reservationStats(state, { nowMs: later, ttlMs: 20 * MIN }).live, 0);
  assert.equal(admitReservation(state, { renter: renter(1), nonce: nonce(99), nowMs: later, policy: policy() }).ok, true);
});

test("re-requesting the same nonce is idempotent and does not consume capacity", () => {
  const state = withReservations(2);
  const again = admitReservation(state, { renter: renter(1), nonce: nonce(1), nowMs: 0, policy: policy() });
  assert.deepEqual(again, { ok: true, existing: true });
  const hijack = admitReservation(state, { renter: renter(2), nonce: nonce(1), nowMs: 0, policy: policy() });
  assert.equal(hijack.status, 400);
});

test("attestation enforces the allowlist and the reserved renter", () => {
  const gated = policy({ RENTER_ALLOWLIST: renter(1) });
  const state = { jobs: {}, reservations: {} };
  const args = (quoteRenter, p) => ({ quote: { renter: quoteRenter, tokenIndex: 1 }, nowMs: 0, policy: p });
  assert.equal(admitAttestation(state, { renter: renter(1) }, args(renter(2), gated)).status, 403);
  assert.equal(admitAttestation(state, { renter: renter(1) }, args(renter(2), policy())).status, 400);
  assert.equal(admitAttestation(state, {}, args(renter(2), policy())).ok, true, "legacy reservation without renter");
  assert.equal(admitAttestation(state, { renter: renter(1) }, args(renter(1), gated)).ok, true);
});

test("prune: unattested reservations expire after the TTL even with ingest stalled", () => {
  const state = withReservations(2, { createdAt: 0 });
  assert.equal(pruneReservations(state, { nowMs: 19 * MIN, ttlMs: 20 * MIN, ingestedThroughSec: null }), 0);
  assert.equal(pruneReservations(state, { nowMs: 21 * MIN, ttlMs: 20 * MIN, ingestedThroughSec: null }), 2);
  assert.deepEqual(state.reservations, {});
});

test("prune: an attested reservation survives until ingest has covered its quote deadline", () => {
  const state = withReservations(1, { createdAt: 0 });
  const entry = state.reservations[nonce(1)];
  entry.attestedDigest = `0x${"11".repeat(32)}`;
  entry.quoteDeadline = 15 * 60; // seconds
  const args = { nowMs: 60 * MIN, ttlMs: 20 * MIN };
  assert.equal(pruneReservations(state, { ...args, ingestedThroughSec: null }), 0, "ingest stalled: keep the key");
  assert.equal(pruneReservations(state, { ...args, ingestedThroughSec: 15 * 60 }), 0, "deadline block not yet past");
  assert.equal(pruneReservations(state, { ...args, ingestedThroughSec: 15 * 60 + 1 }), 1);
});

test("prune: legacy attested reservations keep the old 24h rule; protected nonces are never pruned", () => {
  const state = withReservations(2, { createdAt: 0 });
  for (const entry of Object.values(state.reservations)) entry.attestedDigest = `0x${"22".repeat(32)}`;
  const day = 24 * 60 * MIN;
  assert.equal(pruneReservations(state, { nowMs: day + 1, ttlMs: 20 * MIN, ingestedThroughSec: day / 1000 }), 0);
  assert.equal(
    pruneReservations(state, {
      nowMs: day + 5_000,
      ttlMs: 20 * MIN,
      ingestedThroughSec: day / 1000 + 2,
      protectedNonces: new Set([nonce(2)]),
    }),
    1
  );
  assert.deepEqual(Object.keys(state.reservations), [nonce(2)]);
});

test("reservation store: legacy embedded reservations migrate; file is 0600 and atomic", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-res-"));
  try {
    const stateFile = join(dir, "renter-pod-worker-state.json");
    const storeFile = reservationFileFor(stateFile);
    assert.equal(storeFile, join(dir, "renter-pod-worker-state.reservations.json"));
    const legacy = withReservations(1);
    const { migrated } = loadReservationStore(legacy, storeFile);
    assert.equal(migrated, 1);
    saveReservationStore(legacy, storeFile);
    assert.equal(statSync(storeFile).mode & 0o777, 0o600);
    const onDisk = stateForDisk(legacy);
    assert.deepEqual(onDisk.reservations, legacy.reservations, "state file mirrors the store for rollback");

    // Restart: state file without reservations + store file.
    const restarted = { jobs: {}, reservations: {} };
    assert.equal(loadReservationStore(restarted, storeFile).migrated, 0);
    assert.deepEqual(restarted.reservations, legacy.reservations);

    // Crash between store write and state write: both hold the key -> merge, no conflict.
    const both = { jobs: {}, reservations: JSON.parse(readFileSync(storeFile, "utf8")).reservations };
    assert.equal(loadReservationStore(both, storeFile).migrated, 0);

    // A real conflict is surfaced, never silently resolved.
    const conflicting = withReservations(1);
    assert.throws(() => loadReservationStore(conflicting, storeFile), /reconcile by hand/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reservation store tolerates a missing file and rejects garbage", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-res-"));
  try {
    const file = join(dir, "x.reservations.json");
    const state = { jobs: {} };
    assert.equal(loadReservationStore(state, file).migrated, 0);
    assert.deepEqual(state.reservations, {});
    writeFileSync(file, "{not json");
    assert.throws(() => loadReservationStore({ jobs: {} }, file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stateForDisk omits empty hardening containers, keeps non-empty ones and mirrors reservations", () => {
  const state = {
    lastBlock: 1,
    jobs: {},
    reservations: { a: 1 },
    retiredJobs: {},
    ingestRetry: {},
    pendingTxs: { k: {} },
    txNonceHints: {},
  };
  const onDisk = stateForDisk(state);
  assert.deepEqual(onDisk, { lastBlock: 1, jobs: {}, pendingTxs: { k: {} }, reservations: { a: 1 } });
  onDisk.reservations.b = 2;
  assert.deepEqual(state.reservations, { a: 1 }, "in-memory state is not mutated");
  assert.deepEqual(stateForDisk({ lastBlock: 1, jobs: {} }).reservations, {});
});

test("rollback: a pre-hardening worker reading the mirrored state file finds in-flight operator keys", async () => {
  const { claimOperatorReservation } = await import("./renter-pod-keys.mjs");
  const live = withReservations(1);
  const operator = live.reservations[nonce(1)].operator;
  // What the old worker loads: the state file only (it knows no reservation store).
  const rolledBack = JSON.parse(JSON.stringify(stateForDisk(live)));
  const key = claimOperatorReservation(rolledBack, nonce(1), operator);
  assert.equal(key, live.reservations[nonce(1)].operatorKey);
});

test("per-renter ACTIVE-lease cap (MAX_ACTIVE_LEASES_PER_RENTER, default 2): jobs + open/attested reservations", () => {
  const me = renter(1);
  const state = { jobs: {}, reservations: {} };
  state.jobs = {
    3: { tokenIndex: 3, renter: "0x0000000000000000000000000000000000000001".toUpperCase().replace("0X", "0x"), returned: false },
    4: { tokenIndex: 4, renter: me, returned: true },
    5: { tokenIndex: 5, renter: renter(2), returned: false },
  };
  const args = (n, extra = {}) => ({ renter: me, nonce: nonce(n), nowMs: 0, policy: policy(), ...extra });
  // One unreturned job (returned and other renters' jobs do not count): a checkout is fine.
  assert.equal(renterLeaseLoad(state, me, { nowMs: 0, ttlMs: 20 * MIN }), 1);
  assert.equal(admitReservation(state, args(10)).ok, true);
  reserveRandomOperator(state, nonce(10), { now: 0, renter: me });
  // Job + open checkout = 2 leases held or pending: a third is refused with scope "renter".
  const refused = admitReservation(state, args(11));
  assert.equal(refused.status, 429);
  assert.equal(refused.code, "RESERVATION_CAP");
  assert.equal(refused.details.scope, RefusalScope.RENTER);
  assert.equal(refused.details.cap, 2);
  // Other renters are unaffected; a retry of the same nonce is idempotent.
  assert.equal(admitReservation(state, { ...args(12), renter: renter(2) }).ok, true);
  assert.deepEqual(admitReservation(state, args(10)), { ok: true, existing: true });
  // Configurable.
  assert.equal(admitReservation(state, args(11, { policy: policy({ MAX_ACTIVE_LEASES_PER_RENTER: "3" }) })).ok, true);
  // The open checkout expires: capacity comes back.
  assert.equal(admitReservation(state, args(11, { nowMs: 21 * MIN })).ok, true);
});

test("per-renter lease cap at attest: an attested quote counts until its deadline; the same listing counts once", () => {
  const me = renter(1);
  const state = { jobs: { 3: { tokenIndex: 3, renter: me, returned: false } }, reservations: {} };
  reserveRandomOperator(state, nonce(1), { now: 0, renter: me });
  reserveRandomOperator(state, nonce(2), { now: 0, renter: me });
  state.reservations[nonce(1)].attestedDigest = `0x${"01".repeat(32)}`;
  state.reservations[nonce(1)].quoteDeadline = 15 * 60;
  state.reservations[nonce(1)].tokenIndex = 8;
  const attest2 = (tokenIndex, nowMs = 0, p = policy()) =>
    admitAttestation(state, state.reservations[nonce(2)], { quote: { renter: me, tokenIndex, nonce: nonce(2) }, nowMs, policy: p });
  const refused = attest2(9);
  assert.equal(refused.status, 429);
  assert.equal(refused.details.scope, RefusalScope.RENTER, "job #3 + attested #8 + this #9 = 3 > 2");
  assert.equal(attest2(8).ok, true, "a second quote for the already-counted listing adds nothing");
  assert.equal(attest2(3).ok, true, "the listing of its own active job adds nothing");
  assert.equal(attest2(9, 16 * MIN).ok, true, "quote #8 is past its deadline: no longer counted");
});

test("reserve with tokenIndex: early LEASE_CAP (scope market) and a listing mismatch on retry is refused", () => {
  const state = { jobs: { 1: { tokenIndex: 1, renter: renter(5), returned: false } }, reservations: {} };
  const cap1 = policy({ MAX_ACTIVE_LEASES: "1" });
  const early = admitReservation(state, { renter: renter(1), nonce: nonce(1), tokenIndex: 2, nowMs: 0, policy: cap1 });
  assert.equal(early.code, "LEASE_CAP");
  assert.equal(early.details.scope, RefusalScope.MARKET);
  assert.equal(admitReservation(state, { renter: renter(1), nonce: nonce(1), tokenIndex: 2, nowMs: 0, policy: policy() }).tokenIndex, 2);
  reserveRandomOperator(state, nonce(1), { now: 0, renter: renter(1) });
  state.reservations[nonce(1)].tokenIndex = 2;
  const other = admitReservation(state, { renter: renter(1), nonce: nonce(1), tokenIndex: 7, nowMs: 0, policy: policy() });
  assert.equal(other.status, 400);
  assert.match(other.error, /different listing/);
});

test("holdAttestationSlot: a held slot counts toward LEASE_CAP at once; rollback restores; it expires on its own", () => {
  const state = withReservations(2, { renterOf: (i) => renter(60 + i) });
  const first = state.reservations[nonce(1)];
  const slot = holdAttestationSlot(first, 12, 0);
  let capacity = leaseCapacity(state, { nowMs: 0, ttlMs: 20 * MIN });
  assert.deepEqual([...capacity.pendingTokens], [12]);
  const cap1 = policy({ MAX_ACTIVE_LEASES: "1" });
  const second = admitAttestation(state, state.reservations[nonce(2)], { quote: { renter: renter(61), tokenIndex: 13 }, nowMs: 0, policy: cap1 });
  assert.equal(second.code, "LEASE_CAP", "the in-flight attest already holds the only slot");
  slot.rollback();
  assert.equal(first.tokenIndex, undefined);
  assert.equal(first.attestPendingUntil, undefined);
  assert.equal(leaseCapacity(state, { nowMs: 0, ttlMs: 20 * MIN }).used, 0);
  // A crash leaves the stamp behind: it stops counting after ATTEST_PROVISIONAL_MS.
  holdAttestationSlot(first, 12, 0);
  capacity = leaseCapacity(state, { nowMs: ATTEST_PROVISIONAL_MS + 1, ttlMs: 20 * MIN });
  assert.equal(capacity.used, 0);
  // commit() keeps the token and drops only the stamp.
  first.tokenIndex = 4;
  const kept = holdAttestationSlot(first, 12, 0);
  kept.commit();
  kept.rollback();
  assert.equal(first.tokenIndex, 12);
  assert.equal(first.attestPendingUntil, undefined);
});
