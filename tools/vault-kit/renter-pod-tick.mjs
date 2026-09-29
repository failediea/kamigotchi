import { LeaseAlertCode } from "./renter-pod-alerts.mjs";
import { retiredJobKey } from "./renter-pod-ingest.mjs";

/** Pending-tx key: per job, so a retired and a live job for the same Kami
 * never block each other, and per-job ordering is preserved. */
export function txKeyForJob(job) {
  return retiredJobKey(job);
}

const errorText = (error) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 300);

async function runJob(job, handler, { txs, alert, log, nowMs, stageStuckAlertMs, label }) {
  const key = txKeyForJob(job);
  try {
    const pending = txs ? await txs.pendingFor(key) : null;
    if (pending) {
      // A previous tx for this job is still in flight: sending the re-derived
      // action again would duplicate it. Stay retryable; the tracker alerts.
      throw new Error(`waiting for pending tx ${pending.hash} (${pending.label})`);
    }
    await handler(job);
    job.error = null;
    if (job.errorSince != null) job.errorSince = null;
  } catch (error) {
    job.error = errorText(error);
    job.errorSince ??= nowMs;
    // "#N:" prefix is what the existing journal alert greps for.
    log(`#${job.tokenIndex}: ${label ? `[${label}] ` : ""}${job.error}`);
    if (nowMs - Number(job.errorSince) >= stageStuckAlertMs) {
      alert(
        LeaseAlertCode.STAGE_STUCK,
        {
          token: job.tokenIndex,
          job: key.split(":")[1]?.slice(0, 18),
          retired: Boolean(job.retired),
          sinceSec: Math.floor((nowMs - Number(job.errorSince)) / 1000),
          err: job.error.slice(0, 160),
        },
        { key }
      );
    }
  }
}

/**
 * One worker tick. Ingest failure is contained: it is alerted, the durable
 * cursor stays where it was, and every already-known job still gets its
 * endings, gas and returns processed (THR-01 froze all of them).
 */
export async function runWorkerTick({
  state,
  ingest,
  prune = () => 0,
  processJob,
  processRetiredJob,
  txs = null,
  alert = () => {},
  log = (line) => console.error(line),
  now = () => Date.now(),
  stageStuckAlertMs = 30 * 60_000,
  save = () => {},
  // Called after ingest, after pruning and after every job. The worker re-arms
  // its watchdog here, so the watchdog measures time WITHOUT PROGRESS rather
  // than the length of a whole tick (a slow-but-alive RPC with many jobs made
  // every tick exceed the limit at the same job, forever).
  onProgress = () => {},
  // Rotates the job order each tick, so no job is permanently queued behind
  // a slow prefix of other jobs.
  startOffset = 0,
}) {
  const startedAt = now();
  let ingestOk = true;
  try {
    await ingest();
  } catch (error) {
    ingestOk = false;
    const message = errorText(error);
    log(`ingest failed: ${message}`);
    alert(LeaseAlertCode.INGEST_ERROR, { scope: "batch", err: message.slice(0, 200) }, { key: "batch" });
  }
  onProgress("ingest");

  try {
    prune();
  } catch (error) {
    log(`reservation prune failed: ${errorText(error)}`);
  }
  onProgress("prune");

  const common = { txs, alert, log, stageStuckAlertMs };
  for (const job of rotate(Object.values(state.jobs ?? {}).filter((j) => !j.returned), startOffset)) {
    await runJob(job, processJob, { ...common, nowMs: now() });
    onProgress("job");
  }
  for (const job of rotate(Object.values(state.retiredJobs ?? {}).filter((j) => !j.returned), startOffset)) {
    await runJob(job, processRetiredJob, { ...common, nowMs: now(), label: "retired" });
    onProgress("retired-job");
  }
  save();
  return { ingestOk, tickMs: now() - startedAt };
}

/** Round-robin start: element `offset mod n` first, order otherwise kept. */
export function rotate(items, offset) {
  const n = items.length;
  if (n < 2) return items;
  const start = ((Math.trunc(Number(offset) || 0) % n) + n) % n;
  return start ? [...items.slice(start), ...items.slice(0, start)] : items;
}
