/**
 * Human-actionable alert lines. Alerting (worker-alerts.sh, journald greps)
 * matches the literal prefix "[LEASE-ALERT]", so every condition that needs a
 * person is logged as ONE line:
 *
 *   [LEASE-ALERT] <CODE> key=value key=value ...
 *
 * Codes are a closed set shared with the ops and web lanes.
 */
export const LEASE_ALERT_PREFIX = "[LEASE-ALERT]";

export const LeaseAlertCode = Object.freeze({
  WORKER_STALL: "WORKER_STALL",
  INGEST_ERROR: "INGEST_ERROR",
  DEAD_KAMI: "DEAD_KAMI",
  ESCROW_LOW: "ESCROW_LOW",
  EXIT_RESERVE_STOP: "EXIT_RESERVE_STOP",
  RESERVATION_CAP: "RESERVATION_CAP",
  LEASE_CAP: "LEASE_CAP",
  STRATEGY_RESTART_STORM: "STRATEGY_RESTART_STORM",
  TX_TIMEOUT: "TX_TIMEOUT",
  STAGE_STUCK: "STAGE_STUCK",
  // Startup: a missing or malformed .env setting; the worker idles until fixed.
  CONFIG_ERROR: "CONFIG_ERROR",
});

const KNOWN_CODES = new Set(Object.values(LeaseAlertCode));

function alertValue(value) {
  if (value === undefined || value === null) return "-";
  // Single line, no spaces: values are greppable tokens, never free text that
  // could forge a second alert line or split key=value parsing.
  const text = typeof value === "bigint" ? value.toString() : String(value);
  const flat = text.replace(/[\r\n\t]+/g, " ").trim().replace(/\s+/g, "_");
  return (flat || "-").slice(0, 240);
}

export function formatLeaseAlert(code, details = {}) {
  if (!KNOWN_CODES.has(code)) throw new Error(`unknown lease alert code ${code}`);
  const pairs = Object.entries(details)
    .filter(([key]) => /^[A-Za-z][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `${key}=${alertValue(value)}`);
  return [LEASE_ALERT_PREFIX, code, ...pairs].join(" ");
}

/**
 * Rate-limited alert emitter. The first alert for a (code, key) pair is always
 * logged; repeats inside minIntervalMs are counted and reported as
 * `suppressed=N` on the next emitted line, so a hot loop cannot flood the
 * journal (or hide under a line-count threshold) while still never going
 * silent for longer than one interval.
 */
export function createLeaseAlerter({
  log = (line) => console.error(line),
  now = () => Date.now(),
  minIntervalMs = 300_000,
  // Buckets are keyed by caller-chosen keys, some of them request-supplied
  // (RESERVATION_CAP is keyed by renter address). Past this many buckets,
  // every bucket whose interval has elapsed is dropped: a later alert for it
  // would have been emitted anyway, so only its suppressed count is lost.
  maxBuckets = 512,
} = {}) {
  const lastEmitted = new Map();
  const suppressed = new Map();
  function evictExpired(at) {
    for (const [bucket, last] of lastEmitted) {
      if (at - last < minIntervalMs) continue;
      lastEmitted.delete(bucket);
      suppressed.delete(bucket);
    }
  }
  const leaseAlert = function leaseAlert(code, details = {}, { key = "" } = {}) {
    const bucket = `${code}:${key}`;
    const at = now();
    if (lastEmitted.size >= maxBuckets) evictExpired(at);
    const last = lastEmitted.get(bucket);
    if (last !== undefined && at - last < minIntervalMs) {
      suppressed.set(bucket, (suppressed.get(bucket) ?? 0) + 1);
      return false;
    }
    const dropped = suppressed.get(bucket) ?? 0;
    suppressed.delete(bucket);
    lastEmitted.set(bucket, at);
    log(formatLeaseAlert(code, dropped ? { ...details, suppressed: dropped } : details));
    return true;
  };
  leaseAlert.bucketCount = () => lastEmitted.size;
  return leaseAlert;
}
