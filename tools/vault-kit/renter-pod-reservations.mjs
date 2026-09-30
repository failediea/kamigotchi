import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { initializeOperatorKeyState } from "./renter-pod-keys.mjs";
import { writeJsonAtomic } from "./renter-pod-liveness.mjs";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** Legacy rule for attested reservations that predate quoteDeadline tracking. */
export const LEGACY_RESERVATION_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Machine-readable `scope` on every 429 body (and on the alert line), so the
 * quote API can show the right message:
 *   reservation  this renter has MAX_RESERVATIONS_PER_RENTER open checkouts
 *   renter       this renter holds MAX_ACTIVE_LEASES_PER_RENTER leases
 *                (unreturned jobs + open/attested reservations)
 *   lease        this listing has MAX_RESERVATIONS_PER_LISTING open checkouts
 *   market       the market is full: MAX_ACTIVE_LEASES (code LEASE_CAP) or
 *                MAX_LIVE_RESERVATIONS checkouts in flight (code RESERVATION_CAP)
 */
export const RefusalScope = Object.freeze({
  RESERVATION: "reservation",
  RENTER: "renter",
  LEASE: "lease",
  MARKET: "market",
});

/**
 * How long an attestation in progress holds its lease slot before the keeper
 * signature is recorded. The attest handler reserves the slot synchronously,
 * before its awaits (listing check, quoteDigest), so a burst of concurrent
 * attests can never all pass while the market sits at cap - 1. Rolled back on
 * failure; an entry left behind by a crash simply expires.
 */
export const ATTEST_PROVISIONAL_MS = 60_000;

export function normalizeRenter(value) {
  const text = String(value ?? "").trim();
  if (!ADDRESS_RE.test(text)) return null;
  return text.toLowerCase();
}

/** Reservations that can still become a pod from a NEW quote. */
export function isLiveReservation(reservation, nowMs, ttlMs) {
  return nowMs - Number(reservation?.createdAt || 0) <= ttlMs;
}

/**
 * Live reservation counts. `live` counts every reservation inside the TTL
 * (released ones included: they still occupy the store). `perRenter` counts a
 * renter's OPEN checkouts (released ones excluded) for
 * MAX_RESERVATIONS_PER_RENTER; `attemptsPerRenter` counts every reservation
 * the renter created inside the TTL for MAX_RESERVATION_ATTEMPTS_PER_RENTER.
 */
export function reservationStats(state, { nowMs, ttlMs }) {
  initializeOperatorKeyState(state);
  let live = 0;
  const perRenter = new Map();
  const attemptsPerRenter = new Map();
  for (const reservation of Object.values(state.reservations)) {
    if (!isLiveReservation(reservation, nowMs, ttlMs)) continue;
    live++;
    const renter = normalizeRenter(reservation.renter);
    if (!renter) continue;
    attemptsPerRenter.set(renter, (attemptsPerRenter.get(renter) ?? 0) + 1);
    if (!isReleasedReservation(reservation)) perRenter.set(renter, (perRenter.get(renter) ?? 0) + 1);
  }
  return { live, total: Object.keys(state.reservations).length, perRenter, attemptsPerRenter };
}

/** Released by its renter (POST /v1/operator-reservations/release) or by the
 * worker after an INSUFFICIENT_BALANCE attest refusal. */
export function isReleasedReservation(reservation) {
  return Number(reservation?.releasedAt) > 0;
}

/**
 * When a reservation stops holding its checkout: the quote deadline for an
 * attested quote (the factory rejects it afterwards), else the reservation
 * TTL. An attestation in progress holds at least until attestPendingUntil.
 */
export function reservationHoldEndsAt(reservation, ttlMs) {
  let end = Number(reservation?.createdAt || 0) + ttlMs;
  if (reservation?.attestedDigest && Number(reservation.quoteDeadline) > 0) end = Number(reservation.quoteDeadline) * 1000;
  const pending = Number(reservation?.attestPendingUntil);
  return pending > end ? pending : end;
}

export function activeJobCount(state) {
  return Object.values(state.jobs ?? {}).filter((job) => !job.returned).length;
}

/** A Kami listing index as the factory takes it (uint32), or null. */
export function normalizeTokenIndex(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= 0xffffffff ? number : null;
}

/**
 * An attested reservation can still become a pod until the factory's quote
 * deadline (block.timestamp > deadline reverts). Legacy entries without a
 * recorded deadline fall back to the reservation TTL.
 */
export function isPendingAttestation(reservation, nowMs, ttlMs) {
  if (Number(reservation?.attestPendingUntil) > nowMs) return true;
  if (!reservation?.attestedDigest) return false;
  const deadline = Number(reservation.quoteDeadline);
  if (deadline > 0) return nowMs <= deadline * 1000;
  return isLiveReservation(reservation, nowMs, ttlMs);
}

/**
 * Concurrency as the chain can actually realise it. Only one lease can exist
 * per Kami (tokenIndex), so capacity is:
 *   active: tokens with an unreturned job
 *   pending: DISTINCT tokens among keeper-attested quotes that can still be
 *            submitted, excluding tokens already active.
 * Unattested reservations and repeat quotes for the same listing never count,
 * so request volume alone cannot exhaust the cap: an attacker is bounded by
 * the number of real listings they can get quotes for (THR-04 / FE-2).
 */
export function leaseCapacity(state, { nowMs, ttlMs }) {
  const activeTokens = new Set(
    Object.values(state.jobs ?? {})
      .filter((job) => !job.returned)
      .map((job) => Number(job.tokenIndex))
  );
  const pendingTokens = new Set();
  for (const reservation of Object.values(state.reservations ?? {})) {
    const token = normalizeTokenIndex(reservation?.tokenIndex);
    if (token === null || activeTokens.has(token)) continue;
    if (isPendingAttestation(reservation, nowMs, ttlMs)) pendingTokens.add(token);
  }
  return { activeTokens, pendingTokens, used: activeTokens.size + pendingTokens.size };
}

function leaseCapRefusal(capacity, cap) {
  return {
    ok: false,
    status: 429,
    code: "LEASE_CAP",
    error: "the market is at its concurrent lease limit; try again later",
    details: { scope: RefusalScope.MARKET, active: capacity.activeTokens.size, pending: capacity.pendingTokens.size, cap },
  };
}

/** A reservation that stands for a lease its renter may still get: open
 * (unattested, inside the TTL), attested with a quote still submittable, or
 * with an attestation in progress. A released ATTESTED quote still holds (the
 * renter can still submit it); a released unattested one never can. */
export function reservationHoldsLease(reservation, nowMs, ttlMs) {
  if (isPendingAttestation(reservation, nowMs, ttlMs)) return true;
  return !reservation?.attestedDigest && !isReleasedReservation(reservation) && isLiveReservation(reservation, nowMs, ttlMs);
}

/** Key of the per-(renter, listing) cooldown map. */
export function listingCooldownKey(renter, tokenIndex) {
  return `${renter}:${tokenIndex}`;
}

/**
 * LISTING_SINGLE_CHECKOUT: the open checkout another renter holds on `token`,
 * or null. Open = holds its lease (reservationHoldsLease) and not released.
 * Returns { until } (ms) - the latest hold end among the blocking entries.
 */
export function listingCheckoutHold(state, { renter, token, nowMs, ttlMs }) {
  let until = null;
  for (const reservation of Object.values(state.reservations ?? {})) {
    if (normalizeTokenIndex(reservation?.tokenIndex) !== token) continue;
    if (normalizeRenter(reservation.renter) === renter) continue;
    if (isReleasedReservation(reservation) || !reservationHoldsLease(reservation, nowMs, ttlMs)) continue;
    const end = reservationHoldEndsAt(reservation, ttlMs);
    if (until === null || end > until) until = end;
  }
  return until === null ? null : { until };
}

/**
 * LISTING_RESERVE_COOLDOWN_SEC: when `renter` may reserve `token` again, or
 * null when it may now. A cooldown starts when one of the renter's
 * reservations for the listing stopped holding (TTL / quote deadline) without
 * a checkout and without a release: from the recorded map (entries the pruner
 * already removed) or from store entries not pruned yet.
 */
export function listingCooldownUntil(state, { renter, token, nowMs, ttlMs, cooldownMs }) {
  if (!(cooldownMs > 0)) return null;
  let until = Number(state.listingCooldowns?.[listingCooldownKey(renter, token)]) || 0;
  for (const reservation of Object.values(state.reservations ?? {})) {
    if (normalizeTokenIndex(reservation?.tokenIndex) !== token) continue;
    if (normalizeRenter(reservation.renter) !== renter) continue;
    if (isReleasedReservation(reservation) || reservationHoldsLease(reservation, nowMs, ttlMs)) continue;
    const end = reservationHoldEndsAt(reservation, ttlMs) + cooldownMs;
    if (end > until) until = end;
  }
  return until > nowMs ? until : null;
}

const retryAfterSec = (untilMs, nowMs) => Math.max(1, Math.ceil((untilMs - nowMs) / 1000));

/**
 * Release an open checkout (the renter closed or cancelled it). The entry is
 * marked, never deleted: an attested quote can still be submitted until its
 * deadline, so its operator key must stay until the pruner proves it unusable.
 * A released reservation never starts a cooldown, never blocks the listing
 * for other renters and no longer counts toward MAX_RESERVATIONS_PER_RENTER;
 * it still counts toward MAX_LIVE_RESERVATIONS and
 * MAX_RESERVATION_ATTEMPTS_PER_RENTER, and an attested one toward the lease
 * caps (its quote is still valid on-chain). Idempotent.
 * Returns { ok, status, error } or { ok: true, released: boolean }.
 */
export function releaseReservation(state, { nonce, renter, nowMs, reason = "renter" }) {
  const normalized = normalizeRenter(renter);
  if (!normalized) return { ok: false, status: 400, error: "renter address required" };
  const reservation = state.reservations?.[String(nonce ?? "").toLowerCase()];
  if (!reservation) return { ok: true, released: false };
  if (normalizeRenter(reservation.renter) !== normalized) {
    return { ok: false, status: 400, error: "reservation nonce belongs to a different renter" };
  }
  if (isReleasedReservation(reservation)) return { ok: true, released: false };
  reservation.releasedAt = nowMs;
  reservation.releaseReason = reason;
  return { ok: true, released: true };
}

/** A uint128 wei amount as the quote carries it (decimal string or safe integer). */
export function parseWei(value) {
  if (typeof value === "bigint") return value >= 0n && value < 2n ** 128n ? value : null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  const text = String(value ?? "").trim();
  if (!/^\d{1,39}$/.test(text)) return null;
  const wei = BigInt(text);
  return wei < 2n ** 128n ? wei : null;
}

/** Full checkout funding of a quote (setupGasWei + hubGasWei + operatingGasWei), or null. */
export function quoteFundingWei(quote) {
  let total = 0n;
  for (const field of ["setupGasWei", "hubGasWei", "operatingGasWei"]) {
    const wei = parseWei(quote?.[field]);
    if (wei === null) return null;
    total += wei;
  }
  return total;
}

/**
 * REQUIRE_RENTER_BALANCE verdict for a balance already read from the chain.
 * Refusal: 403 { code INSUFFICIENT_BALANCE, scope renter, requiredWei }.
 */
export function renterBalanceAdmission({ renter, balanceWei, requiredWei }) {
  if (BigInt(balanceWei) >= BigInt(requiredWei)) return { ok: true };
  return {
    ok: false,
    status: 403,
    code: "INSUFFICIENT_BALANCE",
    error: "this wallet does not hold enough ETH to fund this lease",
    details: { scope: RefusalScope.RENTER, renter, requiredWei: BigInt(requiredWei).toString() },
    body: { requiredWei: BigInt(requiredWei).toString() },
  };
}

/**
 * Leases one renter holds or may still get: DISTINCT tokens among its
 * unreturned jobs and its lease-holding reservations, plus reservations that
 * do not name a listing yet (each counts once). `candidate` ({ nonce,
 * tokenIndex }) is the request being admitted; it replaces any stored entry
 * with the same nonce.
 */
export function renterLeaseLoad(state, renter, { nowMs, ttlMs, candidate = null }) {
  const tokens = new Set();
  let unnamed = 0;
  const count = (token) => {
    if (token === null) unnamed++;
    else tokens.add(token);
  };
  for (const job of Object.values(state.jobs ?? {})) {
    if (job.returned || normalizeRenter(job.renter) !== renter) continue;
    count(normalizeTokenIndex(job.tokenIndex));
  }
  const skip = candidate ? String(candidate.nonce ?? "").toLowerCase() : null;
  for (const [nonce, reservation] of Object.entries(state.reservations ?? {})) {
    if (skip !== null && nonce.toLowerCase() === skip) continue;
    if (normalizeRenter(reservation?.renter) !== renter) continue;
    if (!reservationHoldsLease(reservation, nowMs, ttlMs)) continue;
    count(normalizeTokenIndex(reservation.tokenIndex));
  }
  if (candidate) count(normalizeTokenIndex(candidate.tokenIndex));
  return tokens.size + unnamed;
}

function renterLeaseCapRefusal(renter, load, cap) {
  return {
    ok: false,
    status: 429,
    code: "RESERVATION_CAP",
    error: "this wallet already has the maximum number of active leases",
    details: { scope: RefusalScope.RENTER, renter, leases: load - 1, cap },
  };
}

/** True when a lease on `token` would exceed MAX_ACTIVE_LEASES. A token that
 * is already counted (active or pending) never adds to the total. */
export function exceedsLeaseCap(capacity, token, cap) {
  if (token !== null && (capacity.activeTokens.has(token) || capacity.pendingTokens.has(token))) return false;
  return capacity.used >= cap;
}

/**
 * Admission control for POST /v1/operator-reservations. Returns
 * { ok: true } or { ok: false, status, code, error }. `code` is the lease alert
 * code to raise (or null for plain client errors).
 *
 * The lease cap is enforced authoritatively at attestation (where the quote's
 * tokenIndex is known). Here it is only an early answer for the UI when the
 * market is already full of REAL leases/attested quotes; unattested
 * reservations never count toward it.
 */
export function admitReservation(state, { renter, nonce, tokenIndex, nowMs, policy }) {
  const normalized = normalizeRenter(renter);
  if (!normalized) {
    return { ok: false, status: 400, code: null, error: "renter address required" };
  }
  if (policy.renterAllowlist && !policy.renterAllowlist.has(normalized)) {
    return { ok: false, status: 403, code: null, error: "renter is not on the renter allowlist" };
  }
  const token = normalizeTokenIndex(tokenIndex);
  if (tokenIndex !== undefined && tokenIndex !== null && token === null) {
    return { ok: false, status: 400, code: null, error: "invalid tokenIndex" };
  }
  const existing = state.reservations?.[String(nonce ?? "").toLowerCase()];
  if (existing) {
    // Idempotent retry of the same quote: no new capacity is consumed.
    const bound = normalizeRenter(existing.renter);
    if (bound && bound !== normalized) {
      return { ok: false, status: 400, code: null, error: "reservation nonce belongs to a different renter" };
    }
    const reservedToken = normalizeTokenIndex(existing.tokenIndex);
    if (token !== null && reservedToken !== null && reservedToken !== token) {
      return { ok: false, status: 400, code: null, error: "reservation nonce belongs to a different listing" };
    }
    if (isReleasedReservation(existing)) {
      return { ok: false, status: 400, code: null, error: "reservation nonce was released" };
    }
    return { ok: true, existing: true };
  }
  if (token !== null) {
    // Sybil guards (open rentals). Evaluated synchronously with the reserve
    // itself, so two concurrent reserves cannot both pass.
    const cooldownUntil = listingCooldownUntil(state, {
      renter: normalized,
      token,
      nowMs,
      ttlMs: policy.reservationTtlMs,
      cooldownMs: policy.listingReserveCooldownMs,
    });
    if (cooldownUntil !== null) {
      return {
        ok: false,
        status: 429,
        code: "LISTING_COOLDOWN",
        error: "your last checkout for this Kami expired; you can reserve it again shortly",
        details: { scope: RefusalScope.LEASE, renter: normalized, tokenIndex: token },
        retryAfterSec: retryAfterSec(cooldownUntil, nowMs),
      };
    }
    if (policy.listingSingleCheckout) {
      const hold = listingCheckoutHold(state, { renter: normalized, token, nowMs, ttlMs: policy.reservationTtlMs });
      if (hold) {
        return {
          ok: false,
          status: 429,
          code: "RESERVATION_CAP",
          error: "someone else is checking out this Kami; try again when their checkout expires",
          details: { scope: RefusalScope.LEASE, tokenIndex: token, live: 1, cap: 1 },
          retryAfterSec: retryAfterSec(hold.until, nowMs),
        };
      }
    }
  }
  if (token !== null) {
    // Early answer only when the listing is named: without it the reserve
    // cannot tell whether the quote is for an already-counted listing.
    const capacity = leaseCapacity(state, { nowMs, ttlMs: policy.reservationTtlMs });
    if (exceedsLeaseCap(capacity, token, policy.maxActiveLeases)) {
      return leaseCapRefusal(capacity, policy.maxActiveLeases);
    }
  }
  const stats = reservationStats(state, { nowMs, ttlMs: policy.reservationTtlMs });
  if (token !== null && policy.maxReservationsPerListing > 0) {
    let forListing = 0;
    for (const reservation of Object.values(state.reservations)) {
      if (
        normalizeTokenIndex(reservation.tokenIndex) === token
        && !isReleasedReservation(reservation)
        && isLiveReservation(reservation, nowMs, policy.reservationTtlMs)
      ) {
        forListing++;
      }
    }
    if (forListing >= policy.maxReservationsPerListing) {
      return {
        ok: false,
        status: 429,
        code: "RESERVATION_CAP",
        error: "too many checkouts are in progress for this Kami; try again in a few minutes",
        details: { scope: RefusalScope.LEASE, tokenIndex: token, live: forListing, cap: policy.maxReservationsPerListing },
      };
    }
  }
  if (stats.live >= policy.maxLiveReservations) {
    return {
      ok: false,
      status: 429,
      code: "RESERVATION_CAP",
      error: "too many checkouts are in progress; try again in a few minutes",
      details: { scope: RefusalScope.MARKET, live: stats.live, cap: policy.maxLiveReservations },
    };
  }
  const mine = stats.perRenter.get(normalized) ?? 0;
  if (mine >= policy.maxReservationsPerRenter) {
    return {
      ok: false,
      status: 429,
      code: "RESERVATION_CAP",
      error: "this wallet already has the maximum number of open checkouts",
      details: { scope: RefusalScope.RESERVATION, renter: normalized, live: mine, cap: policy.maxReservationsPerRenter },
    };
  }
  const attempts = stats.attemptsPerRenter.get(normalized) ?? 0;
  if (attempts >= policy.maxReservationAttemptsPerRenter) {
    return {
      ok: false,
      status: 429,
      code: "RESERVATION_CAP",
      error: "this wallet started too many checkouts recently; try again in a few minutes",
      details: { scope: RefusalScope.RESERVATION, renter: normalized, attempts, cap: policy.maxReservationAttemptsPerRenter },
    };
  }
  const load = renterLeaseLoad(state, normalized, {
    nowMs,
    ttlMs: policy.reservationTtlMs,
    candidate: { nonce, tokenIndex: token },
  });
  if (load > policy.maxActiveLeasesPerRenter) {
    return renterLeaseCapRefusal(normalized, load, policy.maxActiveLeasesPerRenter);
  }
  return { ok: true, existing: false, renter: normalized, tokenIndex: token };
}

/**
 * Admission control for POST /v1/operator-reservations/attest. This is where
 * the lease cap is authoritative: the quote names its tokenIndex, and the
 * keeper signature is what lets a pod be created at all.
 */
export function admitAttestation(state, reservation, { quote, nowMs, policy }) {
  const renter = normalizeRenter(quote?.renter);
  if (!renter) return { ok: false, status: 400, code: null, error: "quote renter address required" };
  if (policy.renterAllowlist && !policy.renterAllowlist.has(renter)) {
    return { ok: false, status: 403, code: null, error: "renter is not on the renter allowlist" };
  }
  const bound = normalizeRenter(reservation?.renter);
  if (bound && bound !== renter) {
    return { ok: false, status: 400, code: null, error: "quote renter does not match the reservation" };
  }
  if (isReleasedReservation(reservation)) {
    return { ok: false, status: 400, code: null, error: "operator reservation was released" };
  }
  const token = normalizeTokenIndex(quote?.tokenIndex);
  if (token === null) return { ok: false, status: 400, code: null, error: "quote tokenIndex required" };
  const reservedToken = normalizeTokenIndex(reservation?.tokenIndex);
  if (reservedToken !== null && reservedToken !== token) {
    return { ok: false, status: 400, code: null, error: "quote tokenIndex does not match the reservation" };
  }
  const capacity = leaseCapacity(state, { nowMs, ttlMs: policy.reservationTtlMs });
  if (exceedsLeaseCap(capacity, token, policy.maxActiveLeases)) {
    return leaseCapRefusal(capacity, policy.maxActiveLeases);
  }
  const nonce = reservationNonce(state, reservation);
  const load = renterLeaseLoad(state, renter, {
    nowMs,
    ttlMs: policy.reservationTtlMs,
    candidate: { nonce: nonce ?? quote?.nonce, tokenIndex: token },
  });
  if (load > policy.maxActiveLeasesPerRenter) {
    return renterLeaseCapRefusal(renter, load, policy.maxActiveLeasesPerRenter);
  }
  return { ok: true, renter, tokenIndex: token };
}

function reservationNonce(state, reservation) {
  for (const [nonce, entry] of Object.entries(state.reservations ?? {})) {
    if (entry === reservation) return nonce;
  }
  return null;
}

/**
 * Hold the lease slot of an admitted attestation BEFORE any await (see
 * ATTEST_PROVISIONAL_MS). Returns rollback(), to call when the attestation
 * does not complete; a completed one calls commit() instead.
 */
export function holdAttestationSlot(reservation, tokenIndex, nowMs, holdMs = ATTEST_PROVISIONAL_MS) {
  const hadToken = Object.prototype.hasOwnProperty.call(reservation, "tokenIndex");
  const previousToken = reservation.tokenIndex;
  reservation.tokenIndex = tokenIndex;
  reservation.attestPendingUntil = nowMs + holdMs;
  let settled = false;
  return {
    commit() {
      settled = true;
      delete reservation.attestPendingUntil;
    },
    rollback() {
      if (settled) return;
      settled = true;
      delete reservation.attestPendingUntil;
      if (hadToken) reservation.tokenIndex = previousToken;
      else delete reservation.tokenIndex;
    },
  };
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
 *
 * A removed reservation that expired without a checkout and was not released
 * leaves a LISTING_RESERVE_COOLDOWN_SEC entry for its (renter, listing) in
 * state.listingCooldowns (persisted with the reservation store); expired
 * cooldown entries are dropped here too.
 */
export function pruneReservations(state, {
  nowMs,
  ttlMs,
  ingestedThroughSec,
  protectedNonces = new Set(),
  legacyMaxAgeMs = LEGACY_RESERVATION_MAX_AGE_MS,
  cooldownMs = 0,
}) {
  initializeOperatorKeyState(state);
  for (const [key, until] of Object.entries(state.listingCooldowns ?? {})) {
    if (!(Number(until) > nowMs)) delete state.listingCooldowns[key];
  }
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
    recordListingCooldown(state, reservation, { nowMs, ttlMs, cooldownMs });
    delete state.reservations[nonce];
    removed++;
  }
  return removed;
}

function recordListingCooldown(state, reservation, { nowMs, ttlMs, cooldownMs }) {
  if (!(cooldownMs > 0) || isReleasedReservation(reservation)) return;
  const renter = normalizeRenter(reservation.renter);
  const token = normalizeTokenIndex(reservation.tokenIndex);
  if (!renter || token === null) return;
  const until = reservationHoldEndsAt(reservation, ttlMs) + cooldownMs;
  if (until <= nowMs) return;
  state.listingCooldowns ??= {};
  const key = listingCooldownKey(renter, token);
  if (!(Number(state.listingCooldowns[key]) >= until)) state.listingCooldowns[key] = until;
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
  let cooldowns = {};
  if (exists(file)) {
    const parsed = JSON.parse(read(file, "utf8"));
    stored = parsed?.reservations ?? {};
    cooldowns = parsed?.listingCooldowns ?? {};
  }
  state.listingCooldowns = { ...cooldowns };
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

/** listingCooldowns is written only when non-empty (idle store keeps its shape). */
export function saveReservationStore(state, file, { write = writeJsonAtomic } = {}) {
  const cooldowns = state.listingCooldowns ?? {};
  write(file, {
    version: 1,
    reservations: state.reservations ?? {},
    ...(Object.keys(cooldowns).length ? { listingCooldowns: cooldowns } : {}),
  });
}

const HARDENING_CONTAINERS = ["retiredJobs", "ingestRetry", "pendingTxs", "txNonceHints"];

/**
 * Serialize job state for disk. The reservation store is the source of truth
 * for reservations (a quote request rewrites only that small file), but every
 * job-state save also MIRRORS the current reservations into the state file's
 * `reservations` map, exactly where a pre-hardening worker keeps them. Rolling
 * back to that worker therefore needs no manual merge: its ingest finds the
 * operator key of any quote that was reserved before the last tick save.
 * (The mirror can lag the store by one tick; on load the two are merged, and a
 * mirrored entry the store already dropped is simply pruned again.)
 *
 * The hardening containers are written only when non-empty, so an idle live
 * state file keeps exactly its pre-hardening shape.
 */
export function stateForDisk(state) {
  // listingCooldowns lives in the reservation store only.
  const { reservations = {}, listingCooldowns: _cooldowns, ...rest } = state;
  for (const key of HARDENING_CONTAINERS) {
    if (rest[key] && typeof rest[key] === "object" && !Object.keys(rest[key]).length) delete rest[key];
  }
  return { ...rest, reservations: { ...reservations } };
}
