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
    ingestAlertAfter: 1,
  });
  assert.equal(result.ingestOk, false);
  assert.deepEqual(processed, [1, 2], "returned jobs are skipped, others processed");
  assert.equal(alerts[0].code, "INGEST_ERROR");
  assert.equal(alerts[0].details.scope, "batch");
  assert.match(logs[0], /^ingest failed \(1 in a row\): event cursor reorg/);
  assert.equal(saved, 1);
});

test("final-verify: one transient ingest failure is logged, not alerted; a persisting one is (default 2 ticks)", async () => {
  let clock = 0;
  const alerts = [];
  const logs = [];
  const ingestHealth = { failures: 0, since: null };
  let fail = true;
  const tick = () =>
    runWorkerTick({
      state: { jobs: {} },
      ingest: async () => {
        if (fail) throw new Error("confirmed block 123 is unavailable");
      },
      processJob: async () => {},
      processRetiredJob: async () => {},
      alert: (code, details) => alerts.push({ code, details }),
      log: (line) => logs.push(line),
      now: () => clock,
      ingestHealth,
    });
  await tick();
  assert.deepEqual(alerts, [], "a single RPC blip does not alert (nor fail a deploy verify)");
  assert.match(logs[0], /ingest failed \(1 in a row\)/);
  fail = false;
  clock += 30_000;
  await tick();
  assert.equal(ingestHealth.failures, 0, "a good tick resets the streak");
  fail = true;
  clock += 30_000;
  await tick();
  assert.deepEqual(alerts, []);
  clock += 30_000;
  await tick();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].code, "INGEST_ERROR");
  assert.equal(alerts[0].details.failures, 2);
  assert.equal(alerts[0].details.sinceSec, 30);
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

test("progress is reported after ingest, prune and every job; job order rotates with startOffset", async () => {
  const state = { jobs: { 1: job(1), 2: job(2), 3: job(3), 4: job(4, { returned: true }) }, retiredJobs: { "9:0x": job(9, { retired: true }) } };
  const progress = [];
  const order = [];
  const deps = {
    state,
    ingest: async () => {},
    processJob: async (j) => order.push(j.tokenIndex),
    processRetiredJob: async (j) => order.push(`r${j.tokenIndex}`),
    log: () => {},
    onProgress: (step) => progress.push(step),
  };
  await runWorkerTick({ ...deps, startOffset: 1 });
  assert.deepEqual(order, [2, 3, 1, "r9"]);
  assert.deepEqual(progress, ["ingest", "prune", "job", "job", "job", "retired-job"]);
  order.length = 0;
  await runWorkerTick({ ...deps, startOffset: 5 });
  assert.deepEqual(order, [3, 1, 2, "r9"], "offset wraps modulo the active job count");
});

test("a job stuck behind a slow prefix is reached within n ticks", async () => {
  const state = { jobs: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, job(n)])) };
  const firsts = new Set();
  for (let tick = 0; tick < 5; tick++) {
    const seen = [];
    await runWorkerTick({
      state,
      ingest: async () => {},
      processJob: async (j) => seen.push(j.tokenIndex),
      processRetiredJob: async () => {},
      log: () => {},
      startOffset: tick,
    });
    firsts.add(seen[0]);
  }
  assert.equal(firsts.size, 5, "every job gets to go first once per n ticks");
});

test("pending-tx keys are per job so a retired and a live job never collide", () => {
  const a = job(7, { nonce: `0x${"a".repeat(64)}` });
  const b = job(7, { nonce: `0x${"b".repeat(64)}` });
  assert.notEqual(txKeyForJob(a), txKeyForJob(b));
});
