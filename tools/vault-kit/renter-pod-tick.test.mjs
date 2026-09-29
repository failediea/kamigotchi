import assert from "node:assert/strict";
import test from "node:test";
import { runWorkerTick, txKeyForJob } from "./renter-pod-tick.mjs";

const job = (tokenIndex, extra = {}) => ({
  tokenIndex,
  nonce: `0x${String(tokenIndex).padStart(64, "0")}`,
  pod: `0x${String(tokenIndex).padStart(40, "0")}`,
  returned: false,
  error: null,
  ...extra,
});

test("ingest failure is alerted but every known job is still processed", async () => {
  const state = { jobs: { 1: job(1), 2: job(2), 3: job(3, { returned: true }) }, retiredJobs: {} };
  const processed = [];
  const alerts = [];
  const logs = [];
  let saved = 0;
  const result = await runWorkerTick({
    state,
    ingest: async () => {
      throw new Error("event cursor reorg at block 5");
    },
    processJob: async (j) => processed.push(j.tokenIndex),
    processRetiredJob: async () => assert.fail("no retired jobs"),
    alert: (code, details) => alerts.push({ code, details }),
    log: (line) => logs.push(line),
    save: () => saved++,
  });
  assert.equal(result.ingestOk, false);
  assert.deepEqual(processed, [1, 2], "returned jobs are skipped, others processed");
  assert.equal(alerts[0].code, "INGEST_ERROR");
  assert.equal(alerts[0].details.scope, "batch");
  assert.match(logs[0], /^ingest failed: event cursor reorg/);
  assert.equal(saved, 1);
});

test("reservation pruning runs even when ingest is failing", async () => {
  let pruned = 0;
  await runWorkerTick({
    state: { jobs: {} },
    ingest: async () => {
      throw new Error("rpc down");
    },
    prune: () => pruned++,
    processJob: async () => {},
    processRetiredJob: async () => {},
    log: () => {},
  });
  assert.equal(pruned, 1);
});

test("one failing job never blocks the others; persistent errors raise STAGE_STUCK", async () => {
  let clock = 1_000_000;
  const state = { jobs: { 1: job(1), 2: job(2) } };
  const processed = [];
  const alerts = [];
  const logs = [];
  const deps = {
    state,
    ingest: async () => {},
    processJob: async (j) => {
      if (j.tokenIndex === 1) throw new Error("walk expected room 12, got 1");
      processed.push(j.tokenIndex);
    },
    processRetiredJob: async () => {},
    alert: (code, details) => alerts.push({ code, details }),
    log: (line) => logs.push(line),
    now: () => clock,
    stageStuckAlertMs: 60_000,
  };
  await runWorkerTick(deps);
  assert.deepEqual(processed, [2]);
  assert.equal(state.jobs[1].error, "walk expected room 12, got 1");
  assert.equal(state.jobs[1].errorSince, 1_000_000);
  assert.ok(logs.includes("#1: walk expected room 12, got 1"), "journal keeps the #N: prefix");
  assert.equal(alerts.length, 0);

  clock += 61_000;
  await runWorkerTick(deps);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].code, "STAGE_STUCK");
  assert.equal(alerts[0].details.token, 1);
  assert.equal(alerts[0].details.sinceSec, 61);
  assert.equal(state.jobs[1].errorSince, 1_000_000, "errorSince is not reset by repeats");
});

test("a job recovers: error and errorSince clear", async () => {
  const state = { jobs: { 1: job(1, { error: "old", errorSince: 5 }) } };
  await runWorkerTick({
    state,
    ingest: async () => {},
    processJob: async () => {},
    processRetiredJob: async () => {},
    log: () => {},
  });
  assert.equal(state.jobs[1].error, null);
  assert.equal(state.jobs[1].errorSince, null);
});

test("a job with an unresolved pending tx is not re-driven (no duplicate send)", async () => {
  const state = { jobs: { 1: job(1), 2: job(2) } };
  const processed = [];
  const txs = {
    pendingFor: async (key) =>
      key === txKeyForJob(state.jobs[1]) ? { hash: "0xabc", label: "endLease" } : null,
  };
  await runWorkerTick({
    state,
    ingest: async () => {},
    processJob: async (j) => processed.push(j.tokenIndex),
    processRetiredJob: async () => {},
    txs,
    log: () => {},
  });
  assert.deepEqual(processed, [2]);
  assert.match(state.jobs[1].error, /waiting for pending tx 0xabc \(endLease\)/);
});

test("retired jobs are driven by the retired handler until returned", async () => {
  const retired = job(7, { retired: true });
  const state = { jobs: {}, retiredJobs: { "7:0xold": retired, "8:0xdone": job(8, { retired: true, returned: true }) } };
  const seen = [];
  await runWorkerTick({
    state,
    ingest: async () => {},
    processJob: async () => assert.fail("live handler must not run for retired jobs"),
    processRetiredJob: async (j) => seen.push(j.tokenIndex),
    log: () => {},
  });
  assert.deepEqual(seen, [7]);
});

test("pending-tx keys are per job so a retired and a live job never collide", () => {
  const a = job(7, { nonce: `0x${"a".repeat(64)}` });
  const b = job(7, { nonce: `0x${"b".repeat(64)}` });
  assert.notEqual(txKeyForJob(a), txKeyForJob(b));
});
