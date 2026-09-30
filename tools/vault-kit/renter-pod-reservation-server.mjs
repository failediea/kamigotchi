import { timingSafeEqual } from "node:crypto";
import { LeaseAlertCode } from "./renter-pod-alerts.mjs";
import { bindOperatorReservationQuote, reserveRandomOperator } from "./renter-pod-keys.mjs";
import {
  RefusalScope,
  admitAttestation,
  admitReservation,
  holdAttestationSlot,
  isLiveReservation,
  isReleasedReservation,
  normalizeRenter,
  parseWei,
  quoteFundingWei,
  releaseReservation,
  renterBalanceAdmission,
} from "./renter-pod-reservations.mjs";

export const RESERVE_PATH = "/v1/operator-reservations";
export const ATTEST_PATH = "/v1/operator-reservations/attest";
export const RELEASE_PATH = "/v1/operator-reservations/release";

const ROUTES = new Set([RESERVE_PATH, ATTEST_PATH, RELEASE_PATH]);

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
 * and checkout release calls. Status contract with the web lane:
 *   401 bad token, 404 unknown route, 400 malformed/mismatched request,
 *   403 renter not allowlisted (no code) or, with REQUIRE_RENTER_BALANCE,
 *       { error, code: INSUFFICIENT_BALANCE, scope: "renter", requiredWei },
 *   429 reservation or lease cap reached,
 *   503 worker stale or halted (heartbeat/ingest older than the limit), or
 *       { error, code: BALANCE_UNAVAILABLE } when the renter's balance could
 *       not be read (fails closed, never admits).
 * Every 429 body is { error, code, scope }: code LEASE_CAP | RESERVATION_CAP |
 * LISTING_COOLDOWN, scope one of RefusalScope (reservation | renter | lease |
 * market; see renter-pod-reservations.mjs). Scope "lease" refusals from the
 * single-checkout lock (RESERVATION_CAP) and the per-listing cooldown
 * (LISTING_COOLDOWN) carry a Retry-After header: the seconds until the other
 * renter's checkout stops holding / the cooldown ends. The renter address
 * stays in the alert only.
 *
 * Request bodies:
 *   reserve {market, factory, nonce, renter, tokenIndex?, fundingWei?}
 *     tokenIndex is optional but the quote API sends it: then the reserve
 *     answers LEASE_CAP early, the single-checkout lock, the listing cooldown
 *     and the per-listing cap apply, and the per-renter lease cap dedupes by
 *     listing. fundingWei (decimal string: setupGasWei + hubGasWei +
 *     operatingGasWei of the quote being priced) makes the reserve refuse an
 *     underfunded wallet before an operator is spent; the attest re-checks.
 *   attest {market, factory, quote}: quote.tokenIndex is REQUIRED, and with
 *     REQUIRE_RENTER_BALANCE the renter's balance must cover the quote's
 *     setupGasWei + hubGasWei + operatingGasWei (authoritative: these are the
 *     totals the keeper signs). An INSUFFICIENT_BALANCE refusal releases an
 *     unattested reservation so it holds nothing.
 *   release {market, factory, nonce, renter} -> 200 { released: boolean }.
 *     The renter closed or cancelled checkout: the reservation stops blocking
 *     the listing and its renter's open-checkout count, and never starts a
 *     cooldown. Idempotent (unknown / already released -> released: false);
 *     answered even while the worker is stale or halted.
 *
 * LEASE_CAP is decided at attest, counting active leases plus DISTINCT
 * listings with a keeper-attested quote still inside its deadline, so repeat
 * or unauthenticated quote requests cannot fill it. The attest holds its slot
 * synchronously before any await, so concurrent attests cannot overrun the
 * cap. The reserve reads the balance BEFORE admission, and admission plus the
 * reservation itself run with no await in between, so concurrent reserves
 * cannot both pass the single-checkout lock.
 *
 * Reservations are persisted with saveReservations() (small separate file,
 * atomic) BEFORE the operator address is returned, so a crash can never hand
 * out an operator whose key was not written down.
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
  saveReservations,
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
            {
              key: scope === RefusalScope.RENTER || scope === RefusalScope.RESERVATION
                ? `${scope}:${admission.details.renter}`
                : scope === RefusalScope.LEASE ? `listing:${admission.details.tokenIndex}` : `${admission.code}:${scope ?? "-"}`,
            }
          );
        }
        writeJson(
          response,
          admission.status,
          {
            error: admission.error,
            ...(admission.code ? { code: admission.code } : {}),
            ...(admission.code && scope ? { scope } : {}),
            ...(admission.body ?? {}),
          },
          { retryAfterSec: admission.retryAfterSec }
        );
      };

      if (request.url === RELEASE_PATH) {
        const result = releaseReservation(state, { nonce: body.nonce, renter: body.renter, nowMs: now() });
        if (!result.ok) {
          writeJson(response, result.status, { error: result.error });
          return;
        }
        if (result.released) saveReservations();
        writeJson(response, 200, { released: result.released });
        return;
      }

      if (request.url === RESERVE_PATH) {
        // Balance first (async), then admission + reserve with no await in
        // between (see above).
        const renter = normalizeRenter(body.renter);
        if (policy.requireRenterBalance && renter && body.fundingWei !== undefined && body.fundingWei !== null) {
          const requiredWei = parseWei(body.fundingWei);
          if (requiredWei === null) {
            writeJson(response, 400, { error: "invalid fundingWei" });
            return;
          }
          const verdict = await checkRenterBalance(renter, requiredWei);
          if (!verdict.ok) {
            refuse(verdict);
            return;
          }
        }
        const nowMs = now();
        const admission = admitReservation(state, {
          renter: body.renter,
          nonce: body.nonce,
          tokenIndex: body.tokenIndex,
          nowMs,
          policy,
        });
        if (!admission.ok) {
          refuse(admission);
          return;
        }
        const reservation = reserveRandomOperator(state, String(body.nonce), {
          now: nowMs,
          renter: admission.existing ? undefined : admission.renter,
          ...(walletFactory ? { walletFactory } : {}),
        });
        if (!admission.existing) {
          if (admission.tokenIndex !== null && admission.tokenIndex !== undefined) {
            state.reservations[String(body.nonce).toLowerCase()].tokenIndex = admission.tokenIndex;
          }
          saveReservations();
        }
        writeJson(response, 201, { operator: reservation.operator });
        return;
      }

      const quote = body.quote;
      const nonce = String(quote?.nonce ?? "").toLowerCase();
      const reservation = state.reservations?.[nonce];
      if (!quote || !reservation) {
        throw new Error("operator attestation does not match a live reservation");
      }
      if (!reservation.attestedDigest && !isLiveReservation(reservation, now(), policy.reservationTtlMs)) {
        // An unattested reservation past its TTL no longer counts toward any
        // cap and may be pruned at any moment; never sign a quote against it.
        throw new Error("operator reservation expired before attestation");
      }
      const admission = admitAttestation(state, reservation, { quote, nowMs: now(), policy });
      if (!admission.ok) {
        refuse(admission);
        return;
      }
      // Hold the lease slot NOW, before the awaits below: a concurrent attest
      // for another listing then already counts this one. Rolled back unless
      // the keeper signature is recorded.
      const slot = holdAttestationSlot(reservation, admission.tokenIndex, now());
      try {
        // Pending leases are counted per listing, so the listing must be real:
        // a made-up tokenIndex must not be able to occupy lease capacity.
        if (!(await listingExists(admission.tokenIndex))) {
          writeJson(response, 400, { error: "unknown listing" });
          return;
        }
        if (policy.requireRenterBalance) {
          const requiredWei = quoteFundingWei(quote);
          if (requiredWei === null) {
            writeJson(response, 400, { error: "quote setupGasWei, hubGasWei and operatingGasWei are required" });
            return;
          }
          const verdict = await checkRenterBalance(admission.renter, requiredWei);
          if (!verdict.ok) {
            if (verdict.code === "INSUFFICIENT_BALANCE" && !reservation.attestedDigest && !isReleasedReservation(reservation)) {
              // Nothing was signed: this reservation must not keep holding the
              // listing (or start a cooldown) for an unfunded wallet.
              reservation.releasedAt = now();
              reservation.releaseReason = "insufficient-balance";
              saveReservations();
            }
            refuse(verdict);
            return;
          }
        }
        const digest = await quoteDigest(quote);
        if (isReleasedReservation(reservation)) throw new Error("operator reservation was released during attestation");
        bindOperatorReservationQuote(state, nonce, quote.operator, digest);
        const deadline = Number(quote.deadline);
        if (Number.isSafeInteger(deadline) && deadline > 0) reservation.quoteDeadline = deadline;
        reservation.renter ??= admission.renter;
        reservation.tokenIndex = admission.tokenIndex;
        slot.commit();
        saveReservations();
        writeJson(response, 200, { keeperSignature: signDigest(digest) });
      } finally {
        slot.rollback();
      }
    } catch (error) {
      log(`operator reservation failed: ${error instanceof Error ? error.message : error}`);
      writeJson(response, 400, { error: "operator reservation failed" });
    }
  };
}
