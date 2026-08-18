import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  EndingAction,
  StageZeroAction,
  TerminalGasPullMode,
  TerminalGasReturnMode,
  endingAction,
  operatorGasHealth,
  operatorGasReturnAmount,
  operatorGasTopUpAmount,
  stageZeroAction,
  terminalGasReturnMode,
  terminalGasPullMode,
} from "./renter-pod-recovery.mjs";

const base = { actualAccID: 20n, podAccID: 20n, ownerAccID: 10n, staked: true, returning: false };
const workerSource = readFileSync(new URL("./renter-pod-worker.mjs", import.meta.url), "utf8");

test("ending action stops harvesting before finalization", () => {
  assert.equal(endingAction("HARVESTING"), EndingAction.STOP_HARVEST);
  assert.equal(endingAction("RESTING"), EndingAction.FINALIZE);
  assert.equal(endingAction("DEAD"), EndingAction.WAIT);
});

test("configures terminal gas return explicitly for v15 and v16", () => {
  assert.equal(terminalGasReturnMode(undefined), TerminalGasReturnMode.FACTORY);
  assert.equal(terminalGasReturnMode("factory"), TerminalGasReturnMode.FACTORY);
  assert.equal(terminalGasReturnMode("skip"), TerminalGasReturnMode.SKIP);
  assert.throws(() => terminalGasReturnMode("auto"), /must be factory or skip/);
  assert.throws(() => terminalGasReturnMode(""), /must be factory or skip/);
});

test("keeps terminal gas pulls disabled unless the factory supports them", () => {
  assert.equal(terminalGasPullMode(undefined), TerminalGasPullMode.CHECK_ONLY);
  assert.equal(terminalGasPullMode("check-only"), TerminalGasPullMode.CHECK_ONLY);
  assert.equal(terminalGasPullMode("factory"), TerminalGasPullMode.FACTORY);
  assert.throws(() => terminalGasPullMode("auto"), /must be check-only or factory/);
});

test("checks operator gas before every terminal pod send", () => {
  const stage4 = workerSource.slice(
    workerSource.indexOf("if (stage === 4)"),
    workerSource.indexOf("if (stage === 5)")
  );
  const stage5 = workerSource.slice(
    workerSource.indexOf("if (stage === 5)"),
    workerSource.indexOf("// A deleted request")
  );
  assert.match(stage4, /ensureOperatorGas[\s\S]+sendSystem/);
  assert.match(stage5, /ensureOperatorGas[\s\S]+sendSystem/);
});

test("terminal dust return never hard-requires a full action of operator gas", () => {
  // Kami #5846: 0.2e12 wei short of a 1.7M-gas action it did not need, and the
  // required check threw before the self-financing dust return and the
  // keeper-signed refund could run - every 30s, for days. The gas-health call
  // in both custody-is-home terminal branches must be advisory.
  const stage4 = workerSource.slice(
    workerSource.indexOf("if (stage === 4)"),
    workerSource.indexOf("if (stage === 5)")
  );
  const stage5 = workerSource.slice(
    workerSource.indexOf("if (stage === 5)"),
    workerSource.indexOf("// A deleted request")
  );
  for (const block of [stage4, stage5]) {
    const ownerBranch = block.slice(block.indexOf("listing.owner)"));
    assert.match(ownerBranch, /ensureOperatorGas\([\s\S]*?required: false/);
  }
  // and the escape hatch only exists behind the option: a required failure
  // still throws
  assert.match(workerSource, /if \(required\) throw new Error\(detail\);/);
});

test("uses the keeper after the stage-four operator returns its gas", () => {
  assert.match(
    workerSource,
    /returnUnusedOperatorGas[\s\S]+factory\.connect\(keeper\)\.finalizePreparingCancellation/
  );
});

test("recovers a finalized lease after local state loss", () => {
  assert.equal(stageZeroAction(base), StageZeroAction.RETURN_FROM_POD);
});

test("confirms a normal return only when the market still marks custody in flight", () => {
  assert.equal(
    stageZeroAction({ ...base, actualAccID: 10n }),
    StageZeroAction.CONFIRM_POOL_RETURN
  );
});

test("finishes an owner-requested return through the deletion path", () => {
  assert.equal(
    stageZeroAction({ ...base, actualAccID: 10n, returning: true }),
    StageZeroAction.CLEAR_OWNER_RETURN
  );
});

test("does not confirm a request cancelled before custody moved", () => {
  assert.equal(
    stageZeroAction({ ...base, actualAccID: 10n, staked: false }),
    StageZeroAction.COMPLETE
  );
});

test("waits when custody is at an unexpected account", () => {
  assert.equal(
    stageZeroAction({ ...base, actualAccID: 99n }),
    StageZeroAction.WAIT
  );
});

test("tops an operator up by only the reserve deficit", () => {
  assert.equal(operatorGasTopUpAmount(29n, 100n, 30n), 1n);
  assert.equal(operatorGasTopUpAmount(0n, 10n, 30n), 10n);
  assert.equal(operatorGasTopUpAmount(30n, 100n, 30n), 0n);
});

test("operator gas health preserves the existing top-up amount", () => {
  assert.deepEqual(operatorGasHealth(1n, 100n, 30n, 10n), {
    topUpAmount: 29n,
    projectedBalance: 30n,
    minimumActionWei: 10n,
    shortfall: 0n,
    canAffordAction: true,
  });
});

test("operator gas health loudly exposes an escrow too small for one action", () => {
  assert.deepEqual(operatorGasHealth(1n, 8n, 30n, 10n), {
    topUpAmount: 8n,
    projectedBalance: 9n,
    minimumActionWei: 10n,
    shortfall: 1n,
    canAffordAction: false,
  });
});

test("operator gas health catches a reserve below the current one-action cost", () => {
  const health = operatorGasHealth(30n, 100n, 30n, 31n);
  assert.equal(health.topUpAmount, 0n);
  assert.equal(health.canAffordAction, false);
  assert.equal(health.shortfall, 1n);
});

test("returns every wei except the exact terminal transaction cost", () => {
  assert.equal(operatorGasReturnAmount(1_000n, 100n, 3n), 700n);
  assert.equal(operatorGasReturnAmount(300n, 100n, 3n), 0n);
});
