import assert from "node:assert/strict";
import test from "node:test";
import {
  StageZeroAction,
  operatorGasReturnAmount,
  operatorGasTopUpAmount,
  stageZeroAction,
} from "./renter-pod-recovery.mjs";

const base = { actualAccID: 20n, podAccID: 20n, ownerAccID: 10n, staked: true, returning: false };

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

test("returns every wei except the exact terminal transaction cost", () => {
  assert.equal(operatorGasReturnAmount(1_000n, 100n, 3n), 700n);
  assert.equal(operatorGasReturnAmount(300n, 100n, 3n), 0n);
});
