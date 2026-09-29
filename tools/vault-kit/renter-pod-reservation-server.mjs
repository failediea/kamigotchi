import { timingSafeEqual } from "node:crypto";
import { LeaseAlertCode } from "./renter-pod-alerts.mjs";
import { bindOperatorReservationQuote, reserveRandomOperator } from "./renter-pod-keys.mjs";
import {
  RefusalScope,
  admitAttestation,
  admitReservation,
  holdAttestationSlot,
  isLiveReservation,
} from "./renter-pod-reservations.mjs";

export const RESERVE_PATH = "/v1/operator-reservations";
export const ATTEST_PATH = "/v1/operator-reservations/attest";

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

function writeJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(status === 503 ? { "Retry-After": "60" } : {}),
  });
  response.end(JSON.stringify(body));
}

/**
 * HTTP handler for the quote API's operator reservation and keeper
 * attestation calls. Status contract with the web lane:
 *   401 bad token, 404 unknown route, 400 malformed/mismatched request,
 *   403 renter not allowlisted, 429 reservation or lease cap reached,
 *   503 worker stale or halted (heartbeat/ingest older than the limit).
 * Every 429 body is { error, code, scope }: code LEASE_CAP | RESERVATION_CAP,
 * scope one of RefusalScope (reservation | renter | lease | market; see
 * renter-pod-reservations.mjs). The renter address stays in the alert only.
 *
 * Request bodies: reserve {market, factory, nonce, renter, tokenIndex?};
 * attest {market, factory, quote} where quote.tokenIndex is REQUIRED.
 * LEASE_CAP is decided at attest, counting active leases plus DISTINCT
 * listings with a keeper-attested quote still inside its deadline, so repeat
 * or unauthenticated quote requests cannot fill it. The attest holds its slot
 * synchronously before any await, so concurrent attests cannot overrun the
 * cap. tokenIndex on reserve is optional but the quote API sends it: then the
 * reserve answers LEASE_CAP early, the per-listing cap
 * (MAX_RESERVATIONS_PER_LISTING) applies and the per-renter lease cap
 * (MAX_ACTIVE_LEASES_PER_RENTER) dedupes by listing.
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
}) {
  return async function handleReservationRequest(request, response) {
    try {
      if (request.method !== "POST" || (request.url !== RESERVE_PATH && request.url !== ATTEST_PATH)) {
        writeJson(response, 404, { error: "not found" });
        return;
      }
      if (!authorizedReservationRequest(request.headers.authorization, token)) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      const status = health();
      if (!status.ok) {
        writeJson(response, 503, { error: "lease worker is not accepting new leases right now", reason: status.reason });
        return;
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
        if (admission.code) {
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
        writeJson(response, admission.status, {
          error: admission.error,
          ...(admission.code ? { code: admission.code } : {}),
          ...(admission.status === 429 && scope ? { scope } : {}),
        });
      };

      if (request.url === RESERVE_PATH) {
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
        const digest = await quoteDigest(quote);
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
