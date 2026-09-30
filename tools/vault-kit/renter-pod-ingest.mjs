import { LeaseAlertCode } from "./renter-pod-alerts.mjs";
import { eventIdentity } from "./renter-pod-events.mjs";
import { OperatorMismatchError, claimOperatorReservation } from "./renter-pod-keys.mjs";

/**
 * RenterPodCreated ingestion that can never wedge the worker.
 *
 * THR-01: the previous loop threw "received a second active RoomPod event"
 * when a token that already had an unreturned job produced a new pod
 * (create -> cancelBeforeDispatch -> create, possibly in one ingest batch or
 * even one tx). The throw escaped tick() before the cursor advanced, so every
 * later tick re-threw and NO job on the market was ever processed again.
 *
 * Now each event is applied independently:
 *  - a conflict is reconciled against the factory's current request for the
 *    token (requests(token).pod), the superseded job is moved to
 *    state.retiredJobs (its remaining work is only "bring the Kami home from
 *    MY pod if it is there, then done") and the live pod's job is adopted;
 *  - any event that cannot be applied right now (RPC failure, missing
 *    reservation, chain view inconsistent with the event order) is parked in
 *    state.ingestRetry, logged as an INGEST_ERROR alert, and retried on every
 *    later tick. The cursor still advances, because the parked event is
 *    durably stored with everything needed to apply it later - nothing is
 *    skipped silently and no other token waits on it.
 *  - the event operator must match the key stored for its nonce (quote
 *    store). A missing or different key is OPERATOR_MISMATCH instead of
 *    INGEST_ERROR: the worker cannot operate that pod, and a human must look
 *    (store restored from an old backup, a quote this worker never issued).
 *    The event stays parked, its nonce is never pruned, and restoring the
 *    right store + restarting adopts it.
 */

export class IngestConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "IngestConflictError";
  }
}

export function initializeIngestState(state) {
  state.jobs ??= {};
  state.retiredJobs ??= {};
  state.ingestRetry ??= {};
  return state;
}

const lower = (value) => String(value ?? "").toLowerCase();

/** Plain, JSON-safe record of one RenterPodCreated log. */
export function renterPodEventRecord(event) {
  const args = event.args;
  const identity = eventIdentity(event);
  return {
    tokenIndex: Number(args.tokenIndex),
    renter: String(args.renter),
    node: Number(args.nodeIndex),
    pod: String(args.pod),
    operator: String(args.operator),
    nonce: String(args.nonce),
    eventBlock: Number(event.blockNumber),
    eventBlockHash: identity.blockHash,
    eventTransactionHash: identity.transactionHash,
    eventIndex: identity.index,
    eventId: identity.id,
  };
}

/** Chain order; jobs without a recorded position sort first (oldest). */
export function compareEventOrder(a, b) {
  const blockA = Number.isFinite(Number(a?.eventBlock)) ? Number(a.eventBlock) : -1;
  const blockB = Number.isFinite(Number(b?.eventBlock)) ? Number(b.eventBlock) : -1;
  if (blockA !== blockB) return blockA - blockB;
  const indexA = Number.isFinite(Number(a?.eventIndex)) ? Number(a.eventIndex) : -1;
  const indexB = Number.isFinite(Number(b?.eventIndex)) ? Number(b.eventIndex) : -1;
  return indexA - indexB;
}

export function retiredJobKey(job) {
  return `${Number(job.tokenIndex)}:${lower(job.nonce)}`;
}

/** Same job shape the worker has always persisted (live state files match). */
export function jobFromRecord(record, operatorKey) {
  return {
    tokenIndex: record.tokenIndex,
    renter: record.renter,
    node: record.node,
    pod: record.pod,
    operator: record.operator,
    operatorKey,
    nonce: record.nonce,
    creds: null,
    strategyStarted: false,
    finalized: false,
    returned: false,
    eventBlock: record.eventBlock,
    eventBlockHash: record.eventBlockHash,
    eventTransactionHash: record.eventTransactionHash,
    eventIndex: record.eventIndex,
    eventId: record.eventId,
  };
}

function retire(state, job, { reason, supersededBy, nowMs }) {
  const key = retiredJobKey(job);
  state.retiredJobs[key] = {
    ...job,
    retired: true,
    retiredReason: reason,
    supersededBy: supersededBy ?? null,
    retiredAt: nowMs,
  };
  return key;
}

function alreadyIngested(state, record) {
  const current = state.jobs[record.tokenIndex];
  if (current && lower(current.nonce) === lower(record.nonce)) return true;
  return Boolean(state.retiredJobs[retiredJobKey(record)]);
}

/**
 * Apply one event. Mutates state only after every read/claim that could fail
 * has succeeded, so a throw leaves state exactly as it was.
 * The reservation is resolved but NOT deleted (see claimOperatorReservation);
 * the returned claimedNonce must be deleted after the state file is saved.
 */
export async function applyRenterPodEvent(state, record, { readRequestPod, nowMs }) {
  initializeIngestState(state);
  if (alreadyIngested(state, record)) return { outcome: "duplicate", claimedNonce: null };

  const existing = state.jobs[record.tokenIndex];
  if (!existing || existing.returned) {
    const operatorKey = claimOperatorReservation(state, record.nonce, record.operator, { remove: false });
    state.jobs[record.tokenIndex] = jobFromRecord(record, operatorKey);
    return { outcome: "adopted", claimedNonce: lower(record.nonce) };
  }

  // Two pods for one token and the older job is not finished. The factory
  // allows a new request only after the old one was deleted (cancel, refund
  // or recovery), so the factory's CURRENT request decides which pod is live.
  const chainPod = lower(await readRequestPod(record.tokenIndex));
  const incomingIsLive = chainPod === lower(record.pod);
  const existingIsLive = chainPod === lower(existing.pod);
  const incomingIsNewer = compareEventOrder(record, existing) > 0;

  if (incomingIsNewer) {
    if (existingIsLive) {
      throw new IngestConflictError(
        `Kami #${record.tokenIndex}: newer pod ${record.pod} but the factory still reports ${existing.pod}; will retry`
      );
    }
    const operatorKey = claimOperatorReservation(state, record.nonce, record.operator, { remove: false });
    retire(state, existing, { reason: "superseded", supersededBy: lower(record.nonce), nowMs });
    state.jobs[record.tokenIndex] = jobFromRecord(record, operatorKey);
    return { outcome: "superseded-existing", claimedNonce: lower(record.nonce) };
  }

  // An older event (replayed from the retry set) for a token whose newer job
  // is already tracked. It can only be live if the chain view is inconsistent.
  if (incomingIsLive) {
    throw new IngestConflictError(
      `Kami #${record.tokenIndex}: older pod ${record.pod} is reported live while newer ${existing.pod} is tracked; will retry`
    );
  }
  const operatorKey = claimOperatorReservation(state, record.nonce, record.operator, { remove: false });
  retire(state, jobFromRecord(record, operatorKey), {
    reason: "stale-event",
    supersededBy: lower(existing.nonce),
    nowMs,
  });
  return { outcome: "retired-incoming", claimedNonce: lower(record.nonce) };
}

/**
 * Apply parked retries (oldest first), then the new batch, each in isolation.
 * Never throws for a single event. Returns the per-event outcomes and the
 * reservation nonces to delete once the state file is durable.
 */
export async function ingestRenterPodRecords(state, records, { readRequestPod, nowMs, alert = () => {}, log = () => {} }) {
  initializeIngestState(state);
  const queue = new Map();
  for (const parked of Object.values(state.ingestRetry).sort(compareEventOrder)) queue.set(parked.eventId, parked);
  for (const record of records) if (!queue.has(record.eventId)) queue.set(record.eventId, record);

  const outcomes = [];
  const claimedNonces = [];
  for (const record of queue.values()) {
    const { attempts: _a, firstFailedAt: _f, lastError: _l, ...plain } = record;
    try {
      const result = await applyRenterPodEvent(state, plain, { readRequestPod, nowMs });
      delete state.ingestRetry[record.eventId];
      if (result.claimedNonce) claimedNonces.push(result.claimedNonce);
      outcomes.push({ eventId: record.eventId, tokenIndex: plain.tokenIndex, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const previous = state.ingestRetry[record.eventId];
      const attempts = Number(previous?.attempts ?? 0) + 1;
      state.ingestRetry[record.eventId] = {
        ...plain,
        attempts,
        firstFailedAt: previous?.firstFailedAt ?? nowMs,
        lastError: message.slice(0, 300),
      };
      log(`ingest #${plain.tokenIndex} ${record.eventId} parked for retry (attempt ${attempts}): ${message}`);
      const mismatch = error instanceof OperatorMismatchError;
      alert(
        mismatch ? LeaseAlertCode.OPERATOR_MISMATCH : LeaseAlertCode.INGEST_ERROR,
        {
          token: plain.tokenIndex,
          nonce: lower(plain.nonce).slice(0, 18),
          event: record.eventId,
          attempts,
          ...(mismatch
            ? { reason: error.reason, pod: plain.pod, operator: plain.operator }
            : { err: message.slice(0, 160) }),
        },
        { key: record.eventId }
      );
      outcomes.push({ eventId: record.eventId, tokenIndex: plain.tokenIndex, outcome: "parked", error: message });
    }
  }
  return { outcomes, claimedNonces };
}

/** Reservation nonces that parked events still need (never prune these). */
export function protectedReservationNonces(state) {
  return new Set(Object.values(state.ingestRetry ?? {}).map((record) => lower(record.nonce)));
}

export const RetiredJobAction = Object.freeze({
  RETURN_FROM_POD: "return-from-pod",
  COMPLETE: "complete",
});

/**
 * A retired job's request no longer exists (a newer request owns the token and
 * the listing flags). Its only possible remaining duty is to bring the Kami
 * home if it is still in THIS job's pod; market flags (clearReturned /
 * confirmReturnedToPool) belong to the live job and are never touched here.
 */
export function retiredJobAction({ actualAccID, podAccID }) {
  return actualAccID === podAccID ? RetiredJobAction.RETURN_FROM_POD : RetiredJobAction.COMPLETE;
}

/** processJob guard: the factory request for this token belongs to another pod. */
export function requestBelongsToOtherPod(job, request) {
  const stage = Number(request?.stage ?? 0);
  if (stage === 0) return false;
  return lower(request.pod) !== lower(job.pod);
}

/**
 * TOCTOU guard for keeper-signed factory calls. The factory keys keeper calls
 * (markLeasePreparing, routePreparedKami, activateProvisionedLease,
 * recoverPreparingFromHub, finalize*) by tokenIndex and checks only the stage,
 * not the pod. processJob reads requests(token) once and then may spend
 * minutes walking; if the renter cancels and re-rents in that window, the
 * keeper call would advance the NEWER request, which this job never
 * provisioned. Re-read the request immediately before signing and abort
 * unless it is still this job's pod at the expected stage.
 */
export function assertRequestStillOurs(job, request, expectedStage, label = "keeper call") {
  const stage = Number(request?.stage ?? 0);
  if (lower(request?.pod) !== lower(job.pod)) {
    throw new IngestConflictError(
      `${label} for Kami #${job.tokenIndex} aborted: the factory request now belongs to pod ${request?.pod}, not ${job.pod}`
    );
  }
  if (stage !== Number(expectedStage)) {
    throw new IngestConflictError(
      `${label} for Kami #${job.tokenIndex} aborted: request stage is ${stage}, expected ${expectedStage}`
    );
  }
}

/**
 * Drop returned retired jobs older than the retention window, so superseded
 * pods do not accumulate in (and get rewritten with) the state file forever.
 * Retired jobs still bringing a Kami home are never dropped. Returns the count.
 */
export function pruneRetiredJobs(state, { nowMs, retentionMs }) {
  let removed = 0;
  for (const [key, job] of Object.entries(state.retiredJobs ?? {})) {
    if (!job.returned) continue;
    if (job.returnedAt == null) {
      // Stamp jobs returned before this field existed; they age from now.
      job.returnedAt = nowMs;
      continue;
    }
    if (nowMs - Number(job.returnedAt) < retentionMs) continue;
    delete state.retiredJobs[key];
    removed++;
  }
  return removed;
}
