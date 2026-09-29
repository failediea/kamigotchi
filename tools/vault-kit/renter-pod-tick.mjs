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

  try {
    prune();
  } catch (error) {
    log(`reservation prune failed: ${errorText(error)}`);
  }

  const common = { txs, alert, log, stageStuckAlertMs };
  for (const job of Object.values(state.jobs ?? {})) {
    if (job.returned) continue;
    await runJob(job, processJob, { ...common, nowMs: now() });
  }
  for (const job of Object.values(state.retiredJobs ?? {})) {
    if (job.returned) continue;
    await runJob(job, processRetiredJob, { ...common, nowMs: now(), label: "retired" });
  }
  save();
  return { ingestOk, tickMs: now() - startedAt };
}
