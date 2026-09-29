import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Crash-safe JSON write: a reader (or a restart after a crash) sees either the
 * previous complete file or the new complete file, never a torn one.
 */
export function writeJsonAtomic(path, value, { mode = 0o600, pretty = true, fs = { writeFileSync, chmodSync, renameSync } } = {}) {
  const temp = `${path}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, pretty ? 2 : 0), { mode });
  fs.chmodSync(temp, mode);
  fs.renameSync(temp, path);
}

/** heartbeat.json lives next to the worker state file (one dir per market). */
export function heartbeatPathFor(stateFile) {
  return join(dirname(stateFile), "heartbeat.json");
}

/** Shared interface contract: exactly these six keys. */
export function buildHeartbeat({ nowMs, lastBlock, lastTickOk, activeJobs, liveReservations, tickMs }) {
  return {
    ts: Math.floor(nowMs / 1000),
    lastBlock: Number(lastBlock ?? 0),
    lastTickOk: Boolean(lastTickOk),
    activeJobs: Number(activeJobs ?? 0),
    liveReservations: Number(liveReservations ?? 0),
    tickMs: Math.max(0, Math.round(Number(tickMs ?? 0))),
  };
}

/**
 * Whether the reservation server may hand out operators and keeper
 * signatures. A worker whose tick loop or event ingest is stale would sign
 * quotes for pods it will never walk, activate or end, so it must refuse (503)
 * until it is demonstrably live again.
 */
export function reservationServiceHealth({
  nowMs,
  heartbeat,
  lastIngestOkAtMs,
  staleMs,
  halted = false,
}) {
  if (halted) return { ok: false, reason: "halted" };
  if (!heartbeat || !Number.isFinite(Number(heartbeat.ts))) {
    return { ok: false, reason: "no-heartbeat" };
  }
  if (nowMs - Number(heartbeat.ts) * 1000 > staleMs) return { ok: false, reason: "heartbeat-stale" };
  if (lastIngestOkAtMs == null || nowMs - lastIngestOkAtMs > staleMs) {
    // Ingest is what claims operator keys for new pods. If it is failing, a new
    // lease would be created on-chain but never picked up.
    return { ok: false, reason: "ingest-stale" };
  }
  return { ok: true, reason: "ok" };
}

/**
 * Tick watchdog. A hung await (RPC, tx wait, Kamibots) keeps the process
 * "active" in systemd while nothing advances. check() is driven by a timer;
 * when a tick has run longer than limitMs it reports the stall once and calls
 * onStall (which in the worker logs WORKER_STALL and exits for a restart).
 */
export function createTickWatchdog({ limitMs, now = () => Date.now(), onStall }) {
  let startedAt = null;
  let fired = false;
  return {
    begin() {
      startedAt = now();
      fired = false;
    },
    end() {
      startedAt = null;
    },
    runningMs() {
      return startedAt === null ? 0 : now() - startedAt;
    },
    check() {
      if (startedAt === null || fired) return false;
      const elapsed = now() - startedAt;
      if (elapsed <= limitMs) return false;
      fired = true;
      onStall({ elapsedMs: elapsed, limitMs });
      return true;
    },
  };
}

/** fetch with a hard deadline covering connect, headers and body. */
export function fetchWithTimeout(url, init = {}, { timeoutMs, fetchImpl = fetch } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("fetch timeout must be positive");
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  return fetchImpl(url, { ...init, signal });
}
