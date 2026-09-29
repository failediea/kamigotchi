import assert from "node:assert/strict";
import test from "node:test";
import { createLeaseAlerter } from "./renter-pod-alerts.mjs";
import { normalizeKamibotsPrefs } from "./kamibots-rental-config.mjs";
import {
  cadenceVerdict,
  exitReservePlan,
  kamibotsBackingOff,
  kamibotsBackoffMs,
  noteKamibotsFailure,
  observeKamiState,
} from "./renter-pod-safety.mjs";

const MARKET = "0x00000000000000000000000000000000000000a3";

function sink() {
  const lines = [];
  return { lines, alert: createLeaseAlerter({ log: (line) => lines.push(line), minIntervalMs: 0 }) };
}

test("DEAD marks the job and emits the contract DEAD_KAMI line", () => {
  const { lines, alert } = sink();
  const job = { tokenIndex: 16218, pod: "0xpod", nonce: "0xn" };
  assert.equal(observeKamiState(job, "DEAD", { nowMs: 1_000, stage: 5, action: "kamiSend", market: MARKET, alert }), true);
  assert.deepEqual(job.dead, { since: 1_000, lastSeenAt: 1_000, stage: 5, action: "kamiSend" });
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^\\[LEASE-ALERT\\] DEAD_KAMI token=16218 market=${MARKET} stage=5 action=kamiSend `));

  observeKamiState(job, "DEAD", { nowMs: 61_000, stage: 3, action: "ending", market: MARKET, alert });
  assert.equal(job.dead.since, 1_000, "first sighting kept");
  assert.equal(job.dead.lastSeenAt, 61_000);
  assert.match(lines[1], /sinceSec=60/);
});

test("a revived Kami clears the DEAD mark so the job resumes", () => {
  const logs = [];
  const job = { tokenIndex: 7, dead: { since: 1, lastSeenAt: 1, stage: 3, action: "active" } };
  assert.equal(observeKamiState(job, "RESTING", { log: (line) => logs.push(line) }), false);
  assert.equal(job.dead, undefined);
  assert.match(logs[0], /RESTING again/);
  assert.equal(observeKamiState({ tokenIndex: 8 }, "HARVESTING"), false);
});

test("exit reserve fires one action before the reserve and resumes only with headroom", () => {
  const base = { gasPrice: 2_500_000n, actionGas: 1_700_000n, exitReserveActions: 3, resumeHeadroomActions: 2 };
  const action = 2_500_000n * 1_700_000n;
  const ok = exitReservePlan({ ...base, balance: action * 3n, escrow: action });
  assert.equal(ok.mode, "ok");
  assert.equal(ok.reserveWei, action * 3n);
  assert.equal(ok.triggerWei, action * 4n);
  const stop = exitReservePlan({ ...base, balance: action * 3n, escrow: action - 1n });
  assert.equal(stop.mode, "stop");
  assert.equal(exitReservePlan({ ...base, balance: action * 5n, escrow: 0n, holding: true }).mode, "hold");
  assert.equal(exitReservePlan({ ...base, balance: action * 5n, escrow: action, holding: true }).mode, "resume");
});

test("exit reserve follows the live gas price", () => {
  const args = { balance: 3n * 10n ** 13n, escrow: 0n, actionGas: 1_700_000n, exitReserveActions: 3 };
  assert.equal(exitReservePlan({ ...args, gasPrice: 2_500_000n }).mode, "ok");
  const plan = exitReservePlan({ ...args, gasPrice: 10n ** 7n });
  assert.equal(plan.triggerWei, 4n * 1_700_000n * 10n ** 7n);
  assert.equal(plan.mode, "stop", "4x price turns a safe balance into an exit");
});

test("cadence guard refuses only an unaffordable raise", () => {
  const options = { defaultNode: 1, botNodes: new Set([1]) };
  const calm = normalizeKamibotsPrefs({ strategy: "rest_v3" }, options);
  const busy = normalizeKamibotsPrefs({ strategy: "harvestAndRest", collectInterval: 1200, scavengeInterval: 1200 }, options);
  const actionWei = 4_250_000_000_000n;
  const common = { actionWei, exitReserveWei: actionWei * 3n, remainingSecs: 3 * 86_400 };

  const poor = cadenceVerdict({ prev: calm, next: busy, availableWei: actionWei * 20n, ...common });
  assert.equal(poor.raised, true);
  assert.equal(poor.allowed, false);
  assert.equal(poor.flagged, true);
  assert.equal(poor.remainingActions, poor.nextPerDay * 3);

  const rich = cadenceVerdict({ prev: calm, next: busy, availableWei: actionWei * 10_000n, ...common });
  assert.equal(rich.allowed, true);

  const lower = cadenceVerdict({ prev: busy, next: calm, availableWei: 0n, ...common });
  assert.equal(lower.allowed, true, "lowering cadence is always allowed");
  assert.equal(lower.raised, false);

  const legacy = cadenceVerdict({ prev: null, next: busy, availableWei: 0n, ...common });
  assert.equal(legacy.allowed, true, "unknown baseline never blocks");
  assert.equal(legacy.flagged, true);
});

test("Kamibots backoff doubles from 30s and caps", () => {
  assert.equal(kamibotsBackoffMs(1), 30_000);
  assert.equal(kamibotsBackoffMs(2), 60_000);
  assert.equal(kamibotsBackoffMs(10), 900_000);
  assert.equal(kamibotsBackoffMs(50, 120_000), 120_000);
  const record = noteKamibotsFailure(undefined, new Error("503 down"), 1_000, 900_000);
  assert.deepEqual(record, { failures: 1, retryAt: 31_000, lastError: "503 down" });
  assert.equal(kamibotsBackingOff(record, 30_999), true);
  assert.equal(kamibotsBackingOff(record, 31_000), false);
  assert.equal(kamibotsBackingOff(undefined, 0), false);
});

test("operator gas is priced at what Yominet bills: maxFeePerGas for EIP-1559, gasPrice for legacy", async () => {
  const { billedActionGas, operatorFeePerGas } = await import("./renter-pod-safety.mjs");
  const feeData = { gasPrice: 2_500_000n, maxFeePerGas: 5_000_000n };
  assert.equal(operatorFeePerGas(feeData), 5_000_000n, "2 x base fee, as ethers sends it");
  assert.equal(operatorFeePerGas(feeData, "legacy"), 2_500_000n);
  assert.equal(operatorFeePerGas({ gasPrice: 2_500_000n, maxFeePerGas: null }), 2_500_000n, "no 1559 data: legacy tx");
  assert.equal(operatorFeePerGas({ gasPrice: 3n, maxFeePerGas: 2n }), 3n, "never below the node gas price");
  assert.throws(() => operatorFeePerGas({ gasPrice: null }), /no gas price/);
  assert.equal(billedActionGas(1_700_000n), 1_870_000n);
  // The review's case: 3 reserved actions priced at gasPrice funded ~1.5 real
  // EIP-1559 actions. Priced at the billed fee they fund 3.
  const plan = exitReservePlan({
    balance: 0n,
    escrow: 0n,
    gasPrice: operatorFeePerGas(feeData),
    actionGas: billedActionGas(1_700_000n),
    exitReserveActions: 3,
  });
  const realActionCost = (1_611_833n + (1_870_000n - 1_611_833n) / 10n) * 5_000_000n;
  assert.ok(plan.reserveWei >= realActionCost * 3n);
});
