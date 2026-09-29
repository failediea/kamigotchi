import assert from "node:assert/strict";
import test from "node:test";
import { createLeaseAlerter } from "./renter-pod-alerts.mjs";
import {
  LEASE_PREFS_FLOOR,
  kamibotsStrategySignature,
  leasePrefsFloorSignature,
  normalizeKamibotsPrefs,
} from "./kamibots-rental-config.mjs";
import { StopOutcome, StrategyOutcome, createStrategyController } from "./renter-pod-strategy.mjs";

function harness({ prefs = {}, floor = LEASE_PREFS_FLOOR, startFails = 0, stopFails = 0, restartMinIntervalMs = 3_600_000 } = {}) {
  const calls = [];
  const lines = [];
  const logs = [];
  const clock = { now: 1_000_000 };
  const remote = { prefs: JSON.stringify(prefs), startFails, stopFails, started: [] };
  const controller = createStrategyController({
    startRemote: async (job, next) => {
      calls.push("start");
      if (remote.startFails > 0) {
        remote.startFails -= 1;
        throw new Error("POST /api/strategies/start -> 503: down");
      }
      remote.started.push(next);
    },
    stopRemote: async (job) => {
      calls.push("stop");
      if (remote.stopFails > 0) {
        remote.stopFails -= 1;
        throw new Error("DELETE -> 503: down");
      }
      job.strategyStarted = false;
    },
    readRawPrefs: async () => remote.prefs,
    normalize: (job, raw) => normalizeKamibotsPrefs(raw, { defaultNode: job.node, botNodes: new Set([job.node]) }),
    floor,
    restartMinIntervalMs,
    stopMaxFailures: 3,
    retryMaxMs: 900_000,
    market: "0xmarket",
    alert: createLeaseAlerter({ log: (line) => lines.push(line), minIntervalMs: 0, now: () => clock.now }),
    log: (line) => logs.push(line),
    now: () => clock.now,
  });
  const job = { tokenIndex: 7, node: 34, pod: "0xpod", nonce: "0xn", creds: { apiKey: "k", privyId: "p" } };
  return { controller, job, calls, lines, logs, clock, remote };
}

test("the floor is applied when the job's strategy first starts", async () => {
  const h = harness({ prefs: { risk: "aggressive", hpThresholdLow: 5, useHpBasedRest: false, enableFailsafeRest: false } });
  assert.equal(await h.controller.reconcile(h.job), StrategyOutcome.STARTED);
  const sent = h.remote.started[0];
  assert.equal(sent.risk, "balanced");
  assert.equal(sent.hpThresholdLow, 45);
  assert.equal(sent.useHpBasedRest, true);
  assert.equal(sent.enableFailsafeRest, true);
  assert.match(h.job.prefsClamped.summary, /hpThresholdLow 5->45/);
  assert.ok(h.job.prefsClamped.fields.some((row) => row.field === "risk"));
  assert.equal(h.job.strategyFloor, leasePrefsFloorSignature());
  assert.deepEqual(h.job.appliedPrefs, sent);
  assert.match(h.logs[0], /clamped by the lease safety floor/);
});

test("the floor is applied again on every prefs update", async () => {
  const h = harness({ prefs: { risk: "safe" } });
  await h.controller.reconcile(h.job);
  h.clock.now += 2 * 3_600_000;
  h.remote.prefs = JSON.stringify({ risk: "custom", hpThresholdLow: 10, farmInterval: 72_000, useHpBasedRest: false });
  assert.equal(await h.controller.reconcile(h.job), StrategyOutcome.RESTARTED);
  const sent = h.remote.started[1];
  assert.equal(sent.hpThresholdLow, 45);
  assert.equal(sent.farmInterval, 18_000);
  assert.equal(sent.useHpBasedRest, true);
  assert.deepEqual(h.calls, ["start", "stop", "start"]);
});

test("unparseable renter prefs fall back to floored defaults instead of wedging a paid lease", async () => {
  const h = harness();
  h.remote.prefs = "{not json";
  assert.equal(await h.controller.reconcile(h.job), StrategyOutcome.STARTED);
  assert.equal(h.remote.started[0].hpThresholdLow, 45);
  assert.match(h.job.prefsClamped.summary, /prefs invalid-json->defaults/);
});

test("repeated prefs changes restart at most once per window and alert STRATEGY_RESTART_STORM", async () => {
  const h = harness({ prefs: { risk: "safe" } });
  await h.controller.reconcile(h.job);
  h.clock.now += 3_600_001;
  h.remote.prefs = JSON.stringify({ risk: "safe", hpThresholdLow: 55 });
  assert.equal(await h.controller.reconcile(h.job), StrategyOutcome.RESTARTED);
  for (let i = 0; i < 5; i += 1) {
    h.clock.now += 60_000;
    h.remote.prefs = JSON.stringify({ risk: "safe", hpThresholdLow: 56 + i });
    assert.equal(await h.controller.reconcile(h.job), StrategyOutcome.DEBOUNCED);
  }
  assert.deepEqual(h.calls, ["start", "stop", "start"], "no Kamibots calls while debounced");
  assert.ok(h.lines.every((line) => line.startsWith("[LEASE-ALERT] STRATEGY_RESTART_STORM token=7 market=0xmarket reason=debounced")));
  assert.equal(h.lines.length, 5);
  // Latest prefs are applied once the window has passed; nothing is lost.
  h.clock.now += 3_600_000;
  assert.equal(await h.controller.reconcile(h.job), StrategyOutcome.RESTARTED);
  assert.equal(h.remote.started.at(-1).hpThresholdLow, 60);
  assert.equal(h.job.strategyRestarts, 2);
  assert.equal(h.job.pendingStrategySignature, undefined);
});

test("a strategy started without the current floor is replaced immediately", async () => {
  const h = harness({ prefs: { hpThresholdLow: 10 } });
  const unfloored = normalizeKamibotsPrefs({ hpThresholdLow: 10 }, { defaultNode: 34, botNodes: new Set([34]) });
  // Shape of a live job started by the pre-hardening worker.
  Object.assign(h.job, {
    strategyStarted: true,
    strategySignature: kamibotsStrategySignature(unfloored),
    lastStrategyRestartAt: h.clock.now - 1_000,
  });
  assert.equal(await h.controller.reconcile(h.job), StrategyOutcome.RESTARTED);
  assert.equal(h.remote.started[0].hpThresholdLow, 45);
});

test("a legacy strategy already inside the floor is adopted as the baseline without a restart", async () => {
  const h = harness({ prefs: { risk: "safe" } });
  const safe = normalizeKamibotsPrefs({ risk: "safe" }, { defaultNode: 34, botNodes: new Set([34]) });
  Object.assign(h.job, { strategyStarted: true, strategySignature: kamibotsStrategySignature(safe) });
  assert.equal(await h.controller.reconcile(h.job), StrategyOutcome.UNCHANGED);
  assert.deepEqual(h.calls, []);
  assert.equal(h.job.strategyFloor, leasePrefsFloorSignature());
  assert.deepEqual(h.job.appliedPrefs, safe);
});

test("a cadence raise the escrow cannot pay is refused and flagged ESCROW_LOW", async () => {
  const h = harness({ prefs: { strategy: "rest_v3" } });
  await h.controller.reconcile(h.job);
  h.clock.now += 2 * 3_600_000;
  h.remote.prefs = JSON.stringify({ strategy: "harvestAndRest", collectInterval: 1200, scavengeInterval: 1200 });
  const actionWei = 4_250_000_000_000n;
  const budget = { availableWei: actionWei * 30n, actionWei, exitReserveWei: actionWei * 3n, remainingSecs: 5 * 86_400 };
  assert.equal(await h.controller.reconcile(h.job, { budget }), StrategyOutcome.REFUSED);
  assert.deepEqual(h.calls, ["start"], "running strategy kept");
  assert.equal(h.job.prefsRefused.reason, "cadence");
  assert.match(h.lines.at(-1), /^\[LEASE-ALERT\] ESCROW_LOW token=7 market=0xmarket stage=3 reason=cadence-refused /);
  // With enough escrow the same change goes through.
  const rich = { ...budget, availableWei: actionWei * 100_000n };
  assert.equal(await h.controller.reconcile(h.job, { budget: rich }), StrategyOutcome.RESTARTED);
  assert.equal(h.job.prefsRefused, undefined);
});

test("with nothing running, a refused raise restarts the last accepted prefs", async () => {
  const h = harness({ prefs: { strategy: "rest_v3" } });
  await h.controller.reconcile(h.job);
  h.job.strategyStarted = false; // e.g. stopped by the exit reserve, now resumed
  h.remote.prefs = JSON.stringify({ strategy: "harvestAndRest", collectInterval: 1200 });
  const actionWei = 1n;
  const budget = { availableWei: 10n, actionWei, exitReserveWei: 3n, remainingSecs: 86_400 };
  assert.equal(await h.controller.reconcile(h.job, { budget }), StrategyOutcome.STARTED);
  assert.equal(h.remote.started.at(-1).strategy, "rest_v3");
});

test("Kamibots start failures back off instead of retrying every tick", async () => {
  const h = harness({ startFails: 10 });
  await assert.rejects(h.controller.reconcile(h.job), /503/);
  await assert.rejects(h.controller.reconcile(h.job), /backing off 30s/);
  assert.deepEqual(h.calls, ["start"], "second tick made no Kamibots call");
  h.clock.now += 30_000;
  await assert.rejects(h.controller.reconcile(h.job), /503/);
  h.clock.now += 60_000;
  await assert.rejects(h.controller.reconcile(h.job), /503/);
  assert.equal(h.job.kamibotsHealth.failures, 3);
  await assert.rejects(h.controller.reconcile(h.job), /backing off/);
  assert.match(h.lines.at(-1), /^\[LEASE-ALERT\] STRATEGY_RESTART_STORM token=7 market=0xmarket reason=kamibots-failing failures=3 /);
  h.remote.startFails = 0;
  h.clock.now += 120_000;
  assert.equal(await h.controller.reconcile(h.job), StrategyOutcome.STARTED);
  assert.equal(h.job.kamibotsHealth, undefined);
});

test("a held job (DEAD or exit reserve) never starts a strategy", async () => {
  const h = harness();
  h.job.dead = { since: 1 };
  assert.equal(await h.controller.reconcile(h.job), StrategyOutcome.HELD);
  delete h.job.dead;
  h.job.exitReserve = { since: 1 };
  assert.equal(await h.controller.reconcile(h.job), StrategyOutcome.HELD);
  assert.deepEqual(h.calls, []);
});

test("stop for an on-chain step: retries, then proceeds without Kamibots and backs off", async () => {
  const h = harness({ stopFails: 99 });
  h.job.strategyStarted = true;
  await assert.rejects(h.controller.stopForOnChain(h.job), /503/);
  await assert.rejects(h.controller.stopForOnChain(h.job), /503/);
  assert.equal(await h.controller.stopForOnChain(h.job), StopOutcome.BYPASSED);
  assert.match(h.logs.at(-1), /Kamibots stop failed 3x .*continuing with the on-chain stop path/);
  assert.equal(await h.controller.stopForOnChain(h.job), StopOutcome.BYPASSED);
  assert.equal(h.calls.length, 3, "backing off: no fourth DELETE in the same window");
  h.remote.stopFails = 0;
  h.clock.now += 900_000;
  assert.equal(await h.controller.stopForOnChain(h.job), StopOutcome.STOPPED);
  assert.equal(h.job.strategyStarted, false);
  assert.equal(h.job.kamibotsStop, undefined);
});

test("forced stop (exit reserve) never waits for Kamibots", async () => {
  const h = harness({ stopFails: 1 });
  h.job.strategyStarted = true;
  assert.equal(await h.controller.stopForOnChain(h.job, { force: true }), StopOutcome.BYPASSED);
  assert.equal(await h.controller.stopForOnChain({ ...h.job, strategyStarted: false }), StopOutcome.NONE);
});

test("after a forced bypass the ending path does not re-block on Kamibots", async () => {
  const h = harness({ stopFails: 99 });
  h.job.strategyStarted = true;
  assert.equal(await h.controller.stopForOnChain(h.job, { force: true }), StopOutcome.BYPASSED);
  // Same tick, ending path (not forced): skipped while backing off, no throw.
  assert.equal(await h.controller.stopForOnChain(h.job), StopOutcome.BYPASSED);
  h.clock.now += 31_000;
  // Retry window open: the DELETE fails again but still does not block.
  assert.equal(await h.controller.stopForOnChain(h.job), StopOutcome.BYPASSED);
  assert.equal(h.calls.length, 2);
});
