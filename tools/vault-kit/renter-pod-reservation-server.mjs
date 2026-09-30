import { timingSafeEqual } from "node:crypto";
import { LeaseAlertCode } from "./renter-pod-alerts.mjs";
import { bindOperatorReservationQuote, reserveRandomOperator } from "./renter-pod-keys.mjs";
import {
  RefusalScope,
  admitQuote,
  isLiveReservation,
  isReleasedReservation,
  normalizeRenter,
  parseWei,
  quoteDeadlineAdmission,
  quoteFundingWei,
  releaseReservation,
  renterBalanceAdmission,
  storedReservation,
} from "./renter-pod-reservations.mjs";

export const RESERVE_PATH = "/v1/operator-reservations";
export const ATTEST_PATH = "/v1/operator-reservations/attest";
export const RELEASE_PATH = "/v1/operator-reservations/release";

const ROUTES = new Set([RESERVE_PATH, ATTEST_PATH, RELEASE_PATH]);
const NONCE_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function authorizedReservationRequest(header, token) {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 16_384) throw new Error("reservation body too large");
  }
  return JSON.parse(body || "{}");
}

function writeJson(response, status, body, { retryAfterSec } = {}) {
  const retryAfter = retryAfterSec ?? (status === 503 ? 60 : undefined);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(retryAfter !== undefined ? { "Retry-After": String(retryAfter) } : {}),
  });
  response.end(JSON.stringify(body));
}

/**
 * HTTP handler for the quote API's operator reservation, keeper attestation
 * and checkout release calls.
 *
 * QUOTES HOLD NO CAPACITY (renter-pod-reservations.mjs): every quote gets a
 * fresh random operator key, which is made durable (persist -> quote store
 * append + fsync) BEFORE the operator address or the keeper signature is
 * returned, but nothing counts those keys. The only caps are on-chain leases.
 *
 * Status contract with the web lane:
 *   401 bad token, 404 unknown route, 400 malformed/mismatched request,
 *   403 renter not allowlisted (no code) or, with REQUIRE_RENTER_BALANCE,
 *       { error, code: INSUFFICIENT_BALANCE, scope: "renter", requiredWei },
 *   429 { error, code, scope } when ON-CHAIN leases are at a cap:
 *       code LEASE_CAP scope market (MAX_ACTIVE_LEASES), or
 *       code RESERVATION_CAP scope renter (MAX_ACTIVE_LEASES_PER_RENTER);
 *       no Retry-After (a cap frees up only when a lease ends),
 *   503 worker stale or halted (heartbeat/ingest older than the limit), or
 *       { error, code: BALANCE_UNAVAILABLE } when the renter's balance could
 *       not be read (fails closed, never admits), or
 *       { error, code: KEY_STORE_UNAVAILABLE } when the operator key could not
 *       be made durable (nothing is returned for that quote).
 *       Every 503 carries Retry-After: 60.
 *
 * Request bodies:
 *   reserve {market, factory, nonce, renter, tokenIndex?, fundingWei?}
 *     -> 201 { operator }. Order: body checks, on-chain caps (no RPC), then -
 *     only when fundingWei is sent - one balance read, then a fresh random key
 *     is generated and PERSISTED, then the address is returned. A retry of the
 *     same nonce by the same renter returns the same operator (nothing new).
 *   attest {market, factory, quote} -> 200 { keeperSignature }.
 *     quote.nonce must name a stored reservation of the same renter,
 *     quote.operator must be its operator, quote.tokenIndex is required,
 *     quote.deadline must be in the future and at most RESERVATION_TTL_SEC
 *     ahead; the listing must exist; with REQUIRE_RENTER_BALANCE the renter's
 *     balance must cover setupGasWei + hubGasWei + operatingGasWei. The
 *     binding (digest, deadline) is PERSISTED before the signature is
 *     returned: a signed quote whose key is not on disk cannot exist.
 *   release {market, factory, nonce, renter} -> 200 { released: boolean }.
 *     Optional hygiene: an unattested reservation is deleted (never signed,
 *     so no pod can use it); an attested one is only marked (its key stays
 *     until the quote deadline has passed on-chain). Frees no capacity,
 *     because none is held. Idempotent; answered even while stale or halted.
 */
export function createReservationHandler({
  state,
  token,
  market,
  factory,
  policy,
  health,
  quoteDigest,
  signDigest,
  // persist(nonces): make the CURRENT in-memory entry of each nonce durable
  // (quote store put / del + fsync). Must throw when it could not.
  persist,
  alert = () => {},
  log = (line) => console.error(line),
  now = () => Date.now(),
  walletFactory,
  // Worker: market.listings(tokenIndex).owner is non-zero.
  listingExists = async () => true,
  // Worker: provider.getBalance(renter) on the configured RPC. Required while
  // policy.requireRenterBalance is on (never silently skipped).
  renterBalance,
}) {
  if (typeof persist !== "function") throw new Error("a durable persist(nonces) is required");
  if (policy.requireRenterBalance && typeof renterBalance !== "function") {
    throw new Error("REQUIRE_RENTER_BALANCE is on but no renter balance reader was provided");
  }

  /** Balance gate verdict; an RPC failure fails CLOSED (503). */
  async function checkRenterBalance(renter, requiredWei) {
    let balanceWei;
    try {
      balanceWei = BigInt(await renterBalance(renter));
    } catch (error) {
      log(`renter balance check failed: ${error instanceof Error ? error.message : error}`);
      return {
        ok: false,
        status: 503,
        code: "BALANCE_UNAVAILABLE",
        error: "could not check this wallet's balance right now; try again shortly",
      };
    }
    return renterBalanceAdmission({ renter, balanceWei, requiredWei });
  }

  /** persist() or a 503 KEY_STORE_UNAVAILABLE answer; true when durable. */
  function persistOr503(response, nonces) {
    try {
      persist(nonces);
      return true;
    } catch (error) {
      log(`operator key store write failed: ${error instanceof Error ? error.message : error}`);
      writeJson(response, 503, {
        error: "the lease worker could not store this quote's operator key; try again shortly",
        code: "KEY_STORE_UNAVAILABLE",
      });
      return false;
    }
  }

  return async function handleReservationRequest(request, response) {
    try {
      if (request.method !== "POST" || !ROUTES.has(request.url)) {
        writeJson(response, 404, { error: "not found" });
        return;
      }
      if (!authorizedReservationRequest(request.headers.authorization, token)) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.url !== RELEASE_PATH) {
        const status = health();
        if (!status.ok) {
          writeJson(response, 503, { error: "lease worker is not accepting new leases right now", reason: status.reason });
          return;
        }
      }
      const body = await readBody(request);
      if (
        String(body.market).toLowerCase() !== String(market).toLowerCase()
        || String(body.factory).toLowerCase() !== String(factory).toLowerCase()
      ) {
        writeJson(response, 400, { error: "wrong market or factory" });
        return;
      }

      const refuse = (admission) => {
        const scope = admission.details?.scope;
        if (admission.code && LeaseAlertCode[admission.code]) {
          alert(
            LeaseAlertCode[admission.code],
            { ...(admission.details ?? {}), market: String(market).slice(0, 10) },
            { key: scope === RefusalScope.RENTER ? `${scope}:${admission.details.renter}` : `${admission.code}:${scope ?? "-"}` }
          );
        }
        writeJson(response, admission.status, {
          error: admission.error,
          ...(admission.code ? { code: admission.code } : {}),
          ...(admission.code && scope ? { scope } : {}),
          ...(admission.body ?? {}),
        });
      };

      if (request.url === RELEASE_PATH) {
        const result = releaseReservation(state, { nonce: body.nonce, renter: body.renter, nowMs: now() });
        if (!result.ok) {
          writeJson(response, result.status, { error: result.error });
          return;
        }
        if (result.released && !persistOr503(response, [String(body.nonce).toLowerCase()])) return;
        writeJson(response, 200, { released: result.released });
        return;
      }

      if (request.url === RESERVE_PATH) {
        // Cheap checks first; the only RPC (balance) runs last and only for a
        // request every other check has admitted.
        if (!normalizeRenter(body.renter)) {
          writeJson(response, 400, { error: "renter address required" });
          return;
        }
        if (!NONCE_RE.test(String(body.nonce ?? ""))) {
          writeJson(response, 400, { error: "invalid nonce" });
          return;
        }
        const nonce = String(body.nonce).toLowerCase();
        let requiredWei = null;
        if (body.fundingWei !== undefined && body.fundingWei !== null) {
          requiredWei = parseWei(body.fundingWei);
          if (requiredWei === null) {
            writeJson(response, 400, { error: "invalid fundingWei" });
            return;
          }
        }
        const admission = admitQuote(state, { renter: body.renter, tokenIndex: body.tokenIndex, policy });
        if (!admission.ok) {
          refuse(admission);
          return;
        }
        const checkExisting = () => {
          const existing = storedReservation(state, nonce);
          if (!existing) return null;
          const bound = normalizeRenter(existing.renter);
          if (bound && bound !== admission.renter) return "reservation nonce belongs to a different renter";
          if (admission.tokenIndex !== null && existing.tokenIndex !== undefined && Number(existing.tokenIndex) !== admission.tokenIndex) {
            return "reservation nonce belongs to a different listing";
          }
          if (isReleasedReservation(existing)) return "reservation nonce was released";
          return "";
        };
        const early = checkExisting();
        if (early) {
          writeJson(response, 400, { error: early });
          return;
        }
        if (policy.requireRenterBalance && requiredWei !== null && early === null) {
          const verdict = await checkRenterBalance(admission.renter, requiredWei);
          if (!verdict.ok) {
            refuse(verdict);
            return;
          }
        }
        // From here to the answer there is no await: re-check (a concurrent
        // request may have stored this nonce during the balance read), create
        // the key, make it durable, then return the address.
        const current = checkExisting();
        if (current) {
          writeJson(response, 400, { error: current });
          return;
        }
        if (current === "") {
          // Idempotent retry of the same quote: already durable.
          writeJson(response, 201, { operator: storedReservation(state, nonce).operator });
          return;
        }
        const reservation = reserveRandomOperator(state, nonce, {
          now: now(),
          renter: admission.renter,
          ...(walletFactory ? { walletFactory } : {}),
        });
        if (admission.tokenIndex !== null) state.reservations[nonce].tokenIndex = admission.tokenIndex;
        if (!persistOr503(response, [nonce])) {
          // Never handed out: forget it (a later compaction must not keep it).
          delete state.reservations[nonce];
          return;
        }
        writeJson(response, 201, { operator: reservation.operator });
        return;
      }

      // ATTEST
      const quote = body.quote;
      if (!quote || typeof quote !== "object") {
        writeJson(response, 400, { error: "quote required" });
        return;
      }
      if (!NONCE_RE.test(String(quote.nonce ?? "")) || !ADDRESS_RE.test(String(quote.operator ?? ""))) {
        writeJson(response, 400, { error: "quote nonce and operator required" });
        return;
      }
      const nonce = String(quote.nonce).toLowerCase();
      const reservation = storedReservation(state, nonce);
      if (!reservation) {
        writeJson(response, 400, { error: "operator attestation does not match a stored reservation" });
        return;
      }
      const bound = normalizeRenter(reservation.renter);
      if (bound && bound !== normalizeRenter(quote.renter)) {
        writeJson(response, 400, { error: "quote renter does not match the reservation" });
        return;
      }
      if (isReleasedReservation(reservation)) {
        writeJson(response, 400, { error: "operator reservation was released" });
        return;
      }
      if (String(quote.operator).toLowerCase() !== String(reservation.operator).toLowerCase()) {
        writeJson(response, 400, { error: "quote operator is not the operator reserved for this nonce" });
        return;
      }
      if (!reservation.attestedDigest && !isLiveReservation(reservation, now(), policy.reservationTtlMs)) {
        // An unattested reservation past its TTL may be pruned at any moment;
        // never sign a quote against it.
        writeJson(response, 400, { error: "operator reservation expired before attestation" });
        return;
      }
      const deadline = quoteDeadlineAdmission(quote.deadline, { nowMs: now(), ttlMs: policy.reservationTtlMs });
      if (!deadline.ok) {
        writeJson(response, deadline.status, { error: deadline.error });
        return;
      }
      const admission = admitQuote(state, { renter: quote.renter, tokenIndex: quote.tokenIndex, requireTokenIndex: true, policy });
      if (!admission.ok) {
        refuse(admission);
        return;
      }
      if (reservation.tokenIndex !== undefined && Number(reservation.tokenIndex) !== admission.tokenIndex) {
        writeJson(response, 400, { error: "quote tokenIndex does not match the reservation" });
        return;
      }
      let requiredWei = null;
      if (policy.requireRenterBalance) {
        requiredWei = quoteFundingWei(quote);
        if (requiredWei === null) {
          writeJson(response, 400, { error: "quote setupGasWei, hubGasWei and operatingGasWei are required" });
          return;
        }
      }
      // A made-up tokenIndex never gets a keeper signature.
      if (!(await listingExists(admission.tokenIndex))) {
        writeJson(response, 400, { error: "unknown listing" });
        return;
      }
      if (requiredWei !== null) {
        const verdict = await checkRenterBalance(admission.renter, requiredWei);
        if (!verdict.ok) {
          if (verdict.code === "INSUFFICIENT_BALANCE" && !reservation.attestedDigest) {
            // Nothing was signed: drop the unattested key right away.
            const released = releaseReservation(state, { nonce, renter: admission.renter, nowMs: now(), reason: "insufficient-balance" });
            if (released.ok && released.released) {
              try {
                persist([nonce]);
              } catch (error) {
                log(`operator key store write failed: ${error instanceof Error ? error.message : error}`);
              }
            }
          }
          refuse(verdict);
          return;
        }
      }
      const digest = await quoteDigest(quote);
      // No await from here to the answer. The entry may have been released,
      // pruned or replaced during the awaits above: sign only the same entry.
      if (storedReservation(state, nonce) !== reservation || isReleasedReservation(reservation)) {
        writeJson(response, 400, { error: "operator reservation changed during attestation" });
        return;
      }
      const before = {
        attestedDigest: reservation.attestedDigest,
        quoteDeadline: reservation.quoteDeadline,
        renter: reservation.renter,
        tokenIndex: reservation.tokenIndex,
      };
      bindOperatorReservationQuote(state, nonce, quote.operator, digest);
      reservation.quoteDeadline = Math.max(Number(reservation.quoteDeadline) || 0, deadline.deadline);
      reservation.renter ??= admission.renter;
      reservation.tokenIndex = admission.tokenIndex;
      if (!persistOr503(response, [nonce])) {
        // Not durable: roll the binding back and sign nothing.
        for (const [field, value] of Object.entries(before)) {
          if (value === undefined) delete reservation[field];
          else reservation[field] = value;
        }
        return;
      }
      writeJson(response, 200, { keeperSignature: signDigest(digest) });
    } catch (error) {
      log(`operator reservation failed: ${error instanceof Error ? error.message : error}`);
      if (!response.headersSent) writeJson(response, 400, { error: "operator reservation failed" });
    }
  };
}
