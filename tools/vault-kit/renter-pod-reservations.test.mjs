import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hardeningConfigFromEnv } from "./renter-pod-config.mjs";
import { reserveRandomOperator } from "./renter-pod-keys.mjs";
import {
  admitAttestation,
  admitReservation,
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
  assert.equal(result.details.scope, "renter");
  assert.equal(admitReservation(state, { renter: renter(2), nonce: nonce(99), nowMs: 0, policy: policy() }).ok, true);
});

test("global live-reservation cap is 429 RESERVATION_CAP", () => {
  const state = withReservations(5, { renterOf: (i) => renter(100 + i) });
  const tight = policy({ MAX_LIVE_RESERVATIONS: "5", MAX_ACTIVE_LEASES: "100" });
  const result = admitReservation(state, { renter: renter(1), nonce: nonce(99), nowMs: 0, policy: tight });
  assert.equal(result.status, 429);
  assert.equal(result.code, "RESERVATION_CAP");
  assert.equal(result.details.scope, "global");
});

test("lease cap counts active jobs plus live reservations: 429 LEASE_CAP", () => {
  const state = withReservations(1, { renterOf: () => renter(50) });
  state.jobs = { 1: { returned: false }, 2: { returned: true }, 3: { returned: false } };
  const cap3 = policy({ MAX_ACTIVE_LEASES: "3" });
  const result = admitReservation(state, { renter: renter(1), nonce: nonce(99), nowMs: 0, policy: cap3 });
  assert.equal(result.status, 429);
  assert.equal(result.code, "LEASE_CAP");
  assert.deepEqual(result.details, { active: 2, live: 1, cap: 3 });
  assert.equal(admitReservation(state, { renter: renter(1), nonce: nonce(99), nowMs: 0, policy: policy({ MAX_ACTIVE_LEASES: "4" }) }).ok, true);
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
  assert.equal(admitAttestation({ renter: renter(1) }, { quoteRenter: renter(2), policy: gated }).status, 403);
  assert.equal(admitAttestation({ renter: renter(1) }, { quoteRenter: renter(2), policy: policy() }).status, 400);
  assert.equal(admitAttestation({}, { quoteRenter: renter(2), policy: policy() }).ok, true, "legacy reservation without renter");
  assert.equal(admitAttestation({ renter: renter(1) }, { quoteRenter: renter(1), policy: gated }).ok, true);
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
    assert.deepEqual(onDisk.reservations, {}, "job state no longer carries keys");

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

test("stateForDisk omits empty hardening containers and keeps non-empty ones", () => {
  const state = { lastBlock: 1, jobs: {}, reservations: { a: 1 }, retiredJobs: {}, ingestRetry: {}, pendingTxs: { k: {} } };
  assert.deepEqual(stateForDisk(state), { lastBlock: 1, jobs: {}, pendingTxs: { k: {} }, reservations: {} });
  assert.deepEqual(state.reservations, { a: 1 }, "in-memory state is not mutated");
});
