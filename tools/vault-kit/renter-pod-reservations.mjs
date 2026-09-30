import { basename, dirname, join } from "node:path";
import { initializeOperatorKeyState } from "./renter-pod-keys.mjs";
import { mergeReservationEntry } from "./renter-pod-quote-store.mjs";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** Legacy rule for attested reservations that predate quoteDeadline tracking. */
export const LEGACY_RESERVATION_MAX_AGE_MS = 24 * 60 * 60_000;
/** Clock skew allowed between the quote API and the worker for a quote deadline. */
export const QUOTE_DEADLINE_SKEW_SEC = 60;

/**
 * QUOTES HOLD NO CAPACITY.
 *
 * Every quote still gets its own independently random operator key
 * (renter-pod-keys.mjs, V14-01), stored durably before the operator address or
 * the keeper signature leaves the worker (renter-pod-quote-store.mjs). That
 * store is a key vault, not a ledger: NOTHING counts it. There is no
 * reservation cap, listing lock, cooldown, attempt counter or quote-held lease
 * slot a throwaway wallet could occupy. Capacity is counted from leases that
 * exist ON-CHAIN only (ingested RenterPodCreated pods that are not returned,
 * plus on-chain pods parked for ingest retry). Contention between renters for
 * one Kami is settled by the factory, and the web simulates the checkout
 * before the wallet is asked to sign.
 *
 * Honest concurrent checkouts can overshoot MAX_ACTIVE_LEASES by the quotes
 * issued while the market sat just under it; every such lease is a real,
 * renter-funded pod on a real listing, so the overshoot is bounded by the
 * number of listings.
 *
 * Machine-readable `scope` on every 429 body (and on the alert line):
 *   renter  this renter already holds MAX_ACTIVE_LEASES_PER_RENTER on-chain
 *           leases (code RESERVATION_CAP, kept for web compatibility)
 *   market  the market holds MAX_ACTIVE_LEASES on-chain leases (code LEASE_CAP)
 */
export const RefusalScope = Object.freeze({
  RENTER: "renter",
  MARKET: "market",
});

export function normalizeRenter(value) {
  const text = String(value ?? "").trim();
  if (!ADDRESS_RE.test(text)) return null;
  return text.toLowerCase();
}

/** A Kami listing index as the factory takes it (uint32), or null. */
export function normalizeTokenIndex(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= 0xffffffff ? number : null;
}

export function activeJobCount(state) {
  return Object.values(state.jobs ?? {}).filter((job) => !job.returned).length;
}

/**
 * Leases that exist on-chain, as the worker knows them:
 *  - every unreturned job (an ingested RenterPodCreated pod still holding or
 *    returning its Kami), and
 *  - every RenterPodCreated event parked in state.ingestRetry (the pod exists
 *    on-chain; only its adoption is waiting).
 * Distinct per listing (one lease per Kami can exist on-chain).
 * Returns { activeTokens: Set<token>, perRenter: Map<renter, Set<token>> }.
 */
export function onChainLeases(state) {
  const activeTokens = new Set();
  const perRenter = new Map();
  const add = (renter, token) => {
    const normalizedToken = normalizeTokenIndex(token);
    if (normalizedToken === null) return;
    activeTokens.add(normalizedToken);
    const normalizedRenter = normalizeRenter(renter);
    if (!normalizedRenter) return;
    if (!perRenter.has(normalizedRenter)) perRenter.set(normalizedRenter, new Set());
    perRenter.get(normalizedRenter).add(normalizedToken);
  };
  for (const job of Object.values(state.jobs ?? {})) {
    if (!job || job.returned) continue;
    add(job.renter, job.tokenIndex);
  }
  for (const record of Object.values(state.ingestRetry ?? {})) add(record?.renter, record?.tokenIndex);
  return { activeTokens, perRenter };
}

/**
 * Admission for a reserve (tokenIndex optional) or an attest (tokenIndex
 * required). Pure, synchronous, no RPC: runs before any balance read, so a
 * refused request costs one in-memory scan of the on-chain leases. It never
 * looks at the quote store.
 * Returns { ok: true, renter, tokenIndex } or { ok: false, status, code, error, details }.
 */
export function admitQuote(state, { renter, tokenIndex, requireTokenIndex = false, policy }) {
  const normalized = normalizeRenter(renter);
  if (!normalized) return { ok: false, status: 400, code: null, error: "renter address required" };
  if (policy.renterAllowlist && !policy.renterAllowlist.has(normalized)) {
    return { ok: false, status: 403, code: null, error: "renter is not on the renter allowlist" };
  }
  const token = normalizeTokenIndex(tokenIndex);
  if (token === null && (requireTokenIndex || (tokenIndex !== undefined && tokenIndex !== null))) {
    return { ok: false, status: 400, code: null, error: requireTokenIndex ? "quote tokenIndex required" : "invalid tokenIndex" };
  }
  const leases = onChainLeases(state);
  // A listing that already has an on-chain lease adds nothing (its checkout
  // reverts on-chain anyway), so it never trips a cap.
  const alreadyActive = token !== null && leases.activeTokens.has(token);
  if (!alreadyActive && leases.activeTokens.size >= policy.maxActiveLeases) {
    return {
      ok: false,
      status: 429,
      code: "LEASE_CAP",
      error: "the market is at its concurrent lease limit; try again later",
      details: { scope: RefusalScope.MARKET, active: leases.activeTokens.size, cap: policy.maxActiveLeases },
    };
  }
  const mine = leases.perRenter.get(normalized) ?? new Set();
  const counted = token !== null && mine.has(token);
  if (!counted && mine.size >= policy.maxActiveLeasesPerRenter) {
    return {
      ok: false,
      status: 429,
      code: "RESERVATION_CAP",
      error: "this wallet already has the maximum number of active leases",
      details: { scope: RefusalScope.RENTER, renter: normalized, leases: mine.size, cap: policy.maxActiveLeasesPerRenter },
    };
  }
  return { ok: true, renter: normalized, tokenIndex: token };
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
 * A filter for obviously unfunded requests; it reserves nothing.
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
 * The quote deadline the keeper may sign: a uint64 in the future, at most
 * RESERVATION_TTL_SEC (+ QUOTE_DEADLINE_SKEW_SEC) ahead. The bound is what
 * limits how long a signed quote's key must be kept (it is pruned only once
 * the chain has passed the deadline), so it is enforced, never assumed.
 * Returns { ok: true, deadline } or { ok: false, status: 400, error }.
 */
export function quoteDeadlineAdmission(value, { nowMs, ttlMs }) {
  const text = String(value ?? "").trim();
  const deadline = /^\d{1,20}$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(deadline) || deadline <= 0) return { ok: false, status: 400, error: "quote deadline required" };
  const nowSec = Math.floor(nowMs / 1000);
  if (deadline <= nowSec) return { ok: false, status: 400, error: "quote deadline has already passed" };
  if (deadline > nowSec + Math.floor(ttlMs / 1000) + QUOTE_DEADLINE_SKEW_SEC) {
    return { ok: false, status: 400, error: "quote deadline is further ahead than RESERVATION_TTL_SEC allows" };
  }
  return { ok: true, deadline };
}

/** An UNATTESTED reservation can be attested only inside the TTL. */
export function isLiveReservation(reservation, nowMs, ttlMs) {
  return nowMs - Number(reservation?.createdAt || 0) <= ttlMs;
}

/** Released by its renter (POST .../release) or after an INSUFFICIENT_BALANCE attest. */
export function isReleasedReservation(reservation) {
  return Number(reservation?.releasedAt) > 0;
}

/** Stored reservation for `nonce`, or null. */
export function storedReservation(state, nonce) {
  return state.reservations?.[String(nonce ?? "").toLowerCase()] ?? null;
}

/**
 * Keys that can still become a pod (heartbeat `liveReservations`): attested
 * with the quote deadline not yet passed, or unattested, unreleased and inside
 * the TTL. Observability only: nothing is admitted or refused on it.
 */
export function reservationStats(state, { nowMs, ttlMs }) {
  initializeOperatorKeyState(state);
  let live = 0;
  let attested = 0;
  for (const reservation of Object.values(state.reservations)) {
    if (reservation?.attestedDigest) {
      attested++;
      const deadline = Number(reservation.quoteDeadline);
      if (deadline > 0 ? deadline * 1000 >= nowMs : isLiveReservation(reservation, nowMs, ttlMs)) live++;
    } else if (!isReleasedReservation(reservation) && isLiveReservation(reservation, nowMs, ttlMs)) {
      live++;
    }
  }
  return { live, attested, total: Object.keys(state.reservations).length };
}

/**
 * Release a checkout (the renter closed or cancelled it, or the attest found
 * the wallet unfunded). It frees nothing, because a quote holds nothing:
 *  - UNATTESTED: no keeper signature exists, so no pod can ever use the key;
 *    the entry is deleted right away ({ released: true, deleted: true }).
 *  - ATTESTED: the signed quote can still be submitted until its deadline, so
 *    the key must stay until the pruner proves it unusable. The entry is only
 *    marked (it can no longer be re-attested).
 * Renter-bound and idempotent (unknown / already released -> released: false).
 * The caller persists the nonce (quote store sync) when released is true.
 */
export function releaseReservation(state, { nonce, renter, nowMs, reason = "renter" }) {
  const normalized = normalizeRenter(renter);
  if (!normalized) return { ok: false, status: 400, error: "renter address required" };
  const key = String(nonce ?? "").toLowerCase();
  const reservation = state.reservations?.[key];
  if (!reservation) return { ok: true, released: false };
  const bound = normalizeRenter(reservation.renter);
  if (bound && bound !== normalized) {
    return { ok: false, status: 400, error: "reservation nonce belongs to a different renter" };
  }
  if (isReleasedReservation(reservation)) return { ok: true, released: false };
  if (!reservation.attestedDigest) {
    delete state.reservations[key];
    return { ok: true, released: true, deleted: true };
  }
  reservation.releasedAt = nowMs;
  reservation.releaseReason = reason;
  return { ok: true, released: true, deleted: false };
}

/**
 * Nonces of reservations that can never be claimed. Runs every tick,
 * INCLUDING when event ingest is failing, but only selects what is provably
 * unusable:
 *
 *  - never attested (no keeper signature): the factory rejects any quote
 *    without the keeper's signature, so after the TTL no pod can use it;
 *  - attested with a recorded quote deadline: the factory rejects
 *    block.timestamp > deadline, so once ingest has covered a confirmed block
 *    whose timestamp is past the deadline, every pod that used it has already
 *    been ingested and claimed its key. Chain time, never the local clock;
 *  - attested legacy entries (no deadline recorded): the previous 24h rule,
 *    and still only after ingest has covered that time.
 *
 * Nonces in `protectedNonces` (events parked for ingest retry) are never
 * selected. Nothing is ever evicted for space: an unexpired signed quote's
 * key stays however many there are.
 */
export function prunableReservations(state, {
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
  const nonces = [];
  for (const [nonce, reservation] of Object.entries(state.reservations)) {
    if (protectedNonces.has(nonce.toLowerCase())) continue;
    const createdAt = Number(reservation?.createdAt || 0);
    let prunable;
    if (!reservation?.attestedDigest) {
      prunable = nowMs - createdAt > ttlMs;
    } else if (Number(reservation.quoteDeadline) > 0) {
      prunable = ingestedThroughMs !== null && ingestedThroughMs > Number(reservation.quoteDeadline) * 1000;
    } else {
      prunable = nowMs - createdAt > legacyMaxAgeMs
        && ingestedThroughMs !== null
        && ingestedThroughMs > createdAt + legacyMaxAgeMs;
    }
    if (prunable) nonces.push(nonce);
  }
  return nonces;
}

/** Remove prunableReservations() from memory; returns the removed nonces (persist them). */
export function pruneReservations(state, options) {
  const nonces = prunableReservations(state, options);
  for (const nonce of nonces) delete state.reservations[nonce];
  return nonces;
}

/** Default reservation store: next to the job state file, one per market. */
export function reservationFileFor(stateFile) {
  const base = basename(stateFile).replace(/\.json$/i, "");
  return join(dirname(stateFile), `${base}.reservations.json`);
}

/**
 * Put the store's entries (snapshot + journal, from quoteStore.load()) into
 * state.reservations, merging reservations a pre-hardening state file embeds
 * (mergeReservationEntry: never loses a key or a keeper binding; two different
 * operators for one nonce is a hand-reconcile error). The caller must make the
 * store durable (compact) BEFORE the state file drops the embedded entries, so
 * a crash in between leaves the keys in both files, never in neither.
 * Returns { migrated } - entries that existed only in the state file.
 */
export function mergeStoredReservations(state, stored) {
  initializeOperatorKeyState(state);
  const embedded = state.reservations;
  const merged = {};
  for (const [nonce, entry] of Object.entries(stored ?? {})) merged[nonce.toLowerCase()] = entry;
  let migrated = 0;
  for (const [nonce, reservation] of Object.entries(embedded)) {
    const key = nonce.toLowerCase();
    if (!merged[key]) migrated++;
    merged[key] = mergeReservationEntry(merged[key], reservation, key);
  }
  // The retired reservation-capacity design kept listing cooldowns in state.
  delete state.listingCooldowns;
  state.reservations = merged;
  return { migrated };
}

const HARDENING_CONTAINERS = ["retiredJobs", "ingestRetry", "pendingTxs", "txNonceHints"];

/**
 * Serialize job state for disk. Operator keys of quotes in flight live in the
 * quote store only; the state file keeps an EMPTY `reservations` map (its
 * pre-hardening shape). The store used to be mirrored here on every save, but
 * a save then cost O(quotes in flight) and a quote burst made every job-state
 * write slower. A rollback to the pre-hardening worker merges the store into
 * the state file (launch-ops rollback step 3); the worker compacts the journal
 * into the snapshot on SIGTERM, and `node renter-pod-quote-store.mjs compact`
 * does it for a worker that was killed.
 *
 * The hardening containers are written only when non-empty, so an idle live
 * state file keeps exactly its pre-hardening shape.
 */
export function stateForDisk(state) {
  const { reservations: _reservations, listingCooldowns: _cooldowns, ...rest } = state;
  for (const key of HARDENING_CONTAINERS) {
    if (rest[key] && typeof rest[key] === "object" && !Object.keys(rest[key]).length) delete rest[key];
  }
  return { ...rest, reservations: {} };
}
