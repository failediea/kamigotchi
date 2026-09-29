import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { initializeOperatorKeyState } from "./renter-pod-keys.mjs";
import { writeJsonAtomic } from "./renter-pod-liveness.mjs";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** Legacy rule for attested reservations that predate quoteDeadline tracking. */
export const LEGACY_RESERVATION_MAX_AGE_MS = 24 * 60 * 60_000;

export function normalizeRenter(value) {
  const text = String(value ?? "").trim();
  if (!ADDRESS_RE.test(text)) return null;
  return text.toLowerCase();
}

/** Reservations that can still become a pod from a NEW quote. */
export function isLiveReservation(reservation, nowMs, ttlMs) {
  return nowMs - Number(reservation?.createdAt || 0) <= ttlMs;
}

export function reservationStats(state, { nowMs, ttlMs }) {
  initializeOperatorKeyState(state);
  let live = 0;
  const perRenter = new Map();
  for (const reservation of Object.values(state.reservations)) {
    if (!isLiveReservation(reservation, nowMs, ttlMs)) continue;
    live++;
    const renter = normalizeRenter(reservation.renter);
    if (renter) perRenter.set(renter, (perRenter.get(renter) ?? 0) + 1);
  }
  return { live, total: Object.keys(state.reservations).length, perRenter };
}

export function activeJobCount(state) {
  return Object.values(state.jobs ?? {}).filter((job) => !job.returned).length;
}

/**
 * Admission control for POST /v1/operator-reservations. Returns
 * { ok: true } or { ok: false, status, code, error }. `code` is the lease alert
 * code to raise (or null for plain client errors).
 */
export function admitReservation(state, { renter, nonce, nowMs, policy }) {
  const normalized = normalizeRenter(renter);
  if (!normalized) {
    return { ok: false, status: 400, code: null, error: "renter address required" };
  }
  if (policy.renterAllowlist && !policy.renterAllowlist.has(normalized)) {
    return { ok: false, status: 403, code: null, error: "renter is not on the soft-launch allowlist" };
  }
  const existing = state.reservations?.[String(nonce ?? "").toLowerCase()];
  if (existing) {
    // Idempotent retry of the same quote: no new capacity is consumed.
    const bound = normalizeRenter(existing.renter);
    if (bound && bound !== normalized) {
      return { ok: false, status: 400, code: null, error: "reservation nonce belongs to a different renter" };
    }
    return { ok: true, existing: true };
  }
  const stats = reservationStats(state, { nowMs, ttlMs: policy.reservationTtlMs });
  const active = activeJobCount(state);
  if (active + stats.live >= policy.maxActiveLeases) {
    return {
      ok: false,
      status: 429,
      code: "LEASE_CAP",
      error: "the market is at its concurrent lease limit; try again later",
      details: { active, live: stats.live, cap: policy.maxActiveLeases },
    };
  }
  if (stats.live >= policy.maxLiveReservations) {
    return {
      ok: false,
      status: 429,
      code: "RESERVATION_CAP",
      error: "too many checkouts are in progress; try again in a few minutes",
      details: { scope: "global", live: stats.live, cap: policy.maxLiveReservations },
    };
  }
  const mine = stats.perRenter.get(normalized) ?? 0;
  if (mine >= policy.maxReservationsPerRenter) {
    return {
      ok: false,
      status: 429,
      code: "RESERVATION_CAP",
      error: "this wallet already has the maximum number of open checkouts",
      details: { scope: "renter", renter: normalized, live: mine, cap: policy.maxReservationsPerRenter },
    };
  }
  return { ok: true, existing: false, renter: normalized };
}

/** Admission control for POST /v1/operator-reservations/attest. */
export function admitAttestation(reservation, { quoteRenter, policy }) {
  const renter = normalizeRenter(quoteRenter);
  if (!renter) return { ok: false, status: 400, code: null, error: "quote renter address required" };
  if (policy.renterAllowlist && !policy.renterAllowlist.has(renter)) {
    return { ok: false, status: 403, code: null, error: "renter is not on the soft-launch allowlist" };
  }
  const bound = normalizeRenter(reservation?.renter);
  if (bound && bound !== renter) {
    return { ok: false, status: 400, code: null, error: "quote renter does not match the reservation" };
  }
  return { ok: true, renter };
}

/**
 * Remove reservations that can never be claimed. Runs every tick, INCLUDING
 * when event ingest is failing, but only deletes what is provably unusable:
 *
 *  - never attested (no keeper signature): the factory rejects any quote
 *    without the keeper's signature, so after the TTL no pod can use it;
 *  - attested with a recorded quote deadline: the factory rejects
 *    block.timestamp > deadline, so once ingest has covered a confirmed block
 *    whose timestamp is past the deadline, every pod that used it has already
 *    been ingested and claimed its key;
 *  - attested legacy entries (no deadline recorded): the previous 24h rule,
 *    and still only after ingest has covered that time.
 *
 * Nonces in `protectedNonces` (events parked for retry) are never removed.
 */
export function pruneReservations(state, {
  nowMs,
  ttlMs,
  ingestedThroughSec,
  protectedNonces = new Set(),
  legacyMaxAgeMs = LEGACY_RESERVATION_MAX_AGE_MS,
}) {
  initializeOperatorKeyState(state);
  const ingestedThroughMs = Number.isFinite(Number(ingestedThroughSec)) && ingestedThroughSec != null
    ? Number(ingestedThroughSec) * 1000
    : null;
  let removed = 0;
  for (const [nonce, reservation] of Object.entries(state.reservations)) {
    if (protectedNonces.has(nonce)) continue;
    const createdAt = Number(reservation.createdAt || 0);
    if (nowMs - createdAt <= ttlMs) continue;
    let prunable;
    if (!reservation.attestedDigest) {
      prunable = true;
    } else if (Number(reservation.quoteDeadline) > 0) {
      prunable = ingestedThroughMs !== null && ingestedThroughMs > Number(reservation.quoteDeadline) * 1000;
    } else {
      prunable = nowMs - createdAt > legacyMaxAgeMs
        && ingestedThroughMs !== null
        && ingestedThroughMs > createdAt + legacyMaxAgeMs;
    }
    if (!prunable) continue;
    delete state.reservations[nonce];
    removed++;
  }
  return removed;
}

/** Default reservation store: next to the job state file, one per market. */
export function reservationFileFor(stateFile) {
  const base = basename(stateFile).replace(/\.json$/i, "");
  return join(dirname(stateFile), `${base}.reservations.json`);
}

/**
 * Reservations (operator private keys for quotes in flight) are persisted in
 * their own small file so a quote request never rewrites the whole job state.
 *
 * Legacy state files embed `reservations`; they are merged into the store on
 * load. The caller must write the store BEFORE the state file drops them, so a
 * crash in between leaves the keys in both files (harmless), never in neither.
 * Returns { migrated } - the number of entries that came from the state file.
 */
export function loadReservationStore(state, file, { read = readFileSync, exists = existsSync } = {}) {
  initializeOperatorKeyState(state);
  const embedded = state.reservations;
  let stored = {};
  if (exists(file)) {
    const parsed = JSON.parse(read(file, "utf8"));
    stored = parsed?.reservations ?? {};
  }
  const merged = { ...stored };
  let migrated = 0;
  for (const [nonce, reservation] of Object.entries(embedded)) {
    const key = nonce.toLowerCase();
    const current = merged[key];
    if (current && String(current.operator).toLowerCase() !== String(reservation.operator).toLowerCase()) {
      throw new Error(`reservation ${key} differs between the state file and the reservation store; reconcile by hand`);
    }
    if (!current) {
      merged[key] = reservation;
      migrated++;
    }
  }
  state.reservations = merged;
  return { migrated };
}

export function saveReservationStore(state, file, { write = writeJsonAtomic } = {}) {
  write(file, { version: 1, reservations: state.reservations ?? {} });
}

const HARDENING_CONTAINERS = ["retiredJobs", "ingestRetry", "pendingTxs"];

/**
 * Serialize job state for disk. Reservations live in their own store, so the
 * state file keeps an always-empty `reservations` map (the key a rolled-back
 * worker expects). The hardening containers are written only when non-empty,
 * so an idle live state file keeps exactly its pre-hardening shape.
 */
export function stateForDisk(state) {
  const { reservations: _omit, ...rest } = state;
  for (const key of HARDENING_CONTAINERS) {
    if (rest[key] && typeof rest[key] === "object" && !Object.keys(rest[key]).length) delete rest[key];
  }
  return { ...rest, reservations: {} };
}
