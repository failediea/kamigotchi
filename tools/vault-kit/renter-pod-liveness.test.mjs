import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildHeartbeat,
  createTickWatchdog,
  fetchWithTimeout,
  heartbeatPathFor,
  reservationServiceHealth,
  writeJsonAtomic,
} from "./renter-pod-liveness.mjs";

test("heartbeat matches the shared contract exactly", () => {
  const heartbeat = buildHeartbeat({
    nowMs: 1_790_000_000_999,
    lastBlock: 123,
    lastTickOk: true,
    activeJobs: 2,
    liveReservations: 5,
    tickMs: 812.6,
  });
  assert.deepEqual(heartbeat, {
    ts: 1_790_000_000,
    lastBlock: 123,
    lastTickOk: true,
    activeJobs: 2,
    liveReservations: 5,
    tickMs: 813,
  });
  assert.deepEqual(Object.keys(heartbeat), ["ts", "lastBlock", "lastTickOk", "activeJobs", "liveReservations", "tickMs"]);
});

test("heartbeat.json sits next to the state file", () => {
  assert.equal(
    heartbeatPathFor("/root/kamigotchi/tools/vault-kit-v16-vipp/renter-pod-worker-state.json"),
    "/root/kamigotchi/tools/vault-kit-v16-vipp/heartbeat.json"
  );
});

test("atomic JSON write leaves no temp file and applies the mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-live-"));
  try {
    const file = join(dir, "heartbeat.json");
    writeJsonAtomic(file, { ts: 1 }, { mode: 0o644, pretty: false });
    writeJsonAtomic(file, { ts: 2 }, { mode: 0o644, pretty: false });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ts: 2 });
    assert.deepEqual(readdirSync(dir), ["heartbeat.json"]);
    assert.equal(statSync(file).mode & 0o777, 0o644);
    assert.equal(existsSync(`${file}.tmp`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reservation service health: fresh ok; stale heartbeat, stale ingest, halt or no heartbeat -> refuse", () => {
  const nowMs = 1_000_000_000;
  const fresh = { ts: nowMs / 1000 - 30 };
  const base = { nowMs, heartbeat: fresh, lastIngestOkAtMs: nowMs - 30_000, staleMs: 180_000 };
  assert.deepEqual(reservationServiceHealth(base), { ok: true, reason: "ok" });
  assert.equal(reservationServiceHealth({ ...base, heartbeat: null }).reason, "no-heartbeat");
  assert.equal(reservationServiceHealth({ ...base, heartbeat: { ts: nowMs / 1000 - 181 } }).reason, "heartbeat-stale");
  assert.equal(reservationServiceHealth({ ...base, lastIngestOkAtMs: nowMs - 181_000 }).reason, "ingest-stale");
  assert.equal(reservationServiceHealth({ ...base, lastIngestOkAtMs: null }).reason, "ingest-stale");
  assert.equal(reservationServiceHealth({ ...base, halted: true }).reason, "halted");
});

test("tick watchdog fires once when a tick overruns, never for a finished tick", () => {
  let clock = 0;
  const stalls = [];
  const watchdog = createTickWatchdog({ limitMs: 600_000, now: () => clock, onStall: (info) => stalls.push(info) });
  assert.equal(watchdog.check(), false, "idle between ticks");
  watchdog.begin();
  clock = 599_000;
  assert.equal(watchdog.check(), false);
  watchdog.end();
  clock = 2_000_000;
  assert.equal(watchdog.check(), false, "a completed tick never trips");
  watchdog.begin();
  clock += 600_001;
  assert.equal(watchdog.check(), true);
  assert.equal(watchdog.check(), false, "fires once per tick");
  assert.deepEqual(stalls, [{ elapsedMs: 600_001, limitMs: 600_000 }]);
});

test("fetchWithTimeout aborts a hung request", async () => {
  const hung = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  const started = Date.now();
  // AbortSignal.timeout timers are unref'd; hold the loop open like the
  // worker's HTTP server does in production.
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    await assert.rejects(fetchWithTimeout("http://x", {}, { timeoutMs: 50, fetchImpl: hung }), /TimeoutError|aborted|timeout/i);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.ok(Date.now() - started < 2_000);
  assert.throws(() => fetchWithTimeout("http://x", {}, { timeoutMs: 0, fetchImpl: hung }), /positive/);
});
