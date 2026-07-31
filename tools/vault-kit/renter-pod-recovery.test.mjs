import assert from "node:assert/strict";
import test from "node:test";
import {
  EndingAction,
  StageZeroAction,
  endingAction,
  operatorGasHealth,
  operatorGasReturnAmount,
  operatorGasTopUpAmount,
  stageZeroAction,
} from "./renter-pod-recovery.mjs";

const base = { actualAccID: 20n, podAccID: 20n, ownerAccID: 10n, staked: true, returning: false };

test("ending action stops harvesting before finalization", () => {
  assert.equal(endingAction("HARVESTING"), EndingAction.STOP_HARVEST);
  assert.equal(endingAction("RESTING"), EndingAction.FINALIZE);
  assert.equal(endingAction("DEAD"), EndingAction.WAIT);
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
