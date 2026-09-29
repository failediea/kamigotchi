import { chmodSync, closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const NODE_FS = { writeFileSync, chmodSync, renameSync, openSync, fsyncSync, closeSync };

/**
 * Crash-safe JSON write: a reader (or a restart after a crash) sees either the
 * previous complete file or the new complete file, never a torn one.
 *
 * durable (default): the temp file is fsynced before the rename and the
 * directory after it, so a power loss or kernel panic cannot leave a
 * zero-length or missing state / reservation file (those hold operator keys).
 * The heartbeat passes durable:false - it is rewritten every tick anyway.
 */
export function writeJsonAtomic(path, value, { mode = 0o600, pretty = true, durable = true, fs = NODE_FS } = {}) {
  const temp = `${path}.tmp`;
  const body = JSON.stringify(value, null, pretty ? 2 : 0);
  if (!durable) {
    fs.writeFileSync(temp, body, { mode });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, path);
    return;
  }
  const fd = fs.openSync(temp, "w", mode);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(temp, mode);
  fs.renameSync(temp, path);
  let dirFd = null;
  try {
    dirFd = fs.openSync(dirname(path), "r");
    fs.fsyncSync(dirFd);
  } catch {
    // Directory fsync is best effort (not supported on every filesystem);
    // the rename itself is already atomic.
  } finally {
    if (dirFd !== null) fs.closeSync(dirFd);
  }
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
 * when the running tick has made NO PROGRESS for longer than limitMs it
 * reports the stall once and calls onStall (which in the worker logs
 * WORKER_STALL and exits for a restart). progress() re-arms the timer; the
 * worker calls it after ingest and after every job, so a long tick that keeps
 * finishing jobs (slow RPC, many leases) is never killed half-way through.
 */
export function createTickWatchdog({ limitMs, now = () => Date.now(), onStall }) {
  let startedAt = null;
  let fired = false;
  return {
    begin() {
      startedAt = now();
      fired = false;
    },
    progress() {
      if (startedAt !== null && !fired) startedAt = now();
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
