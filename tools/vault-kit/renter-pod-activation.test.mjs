import assert from "node:assert/strict";
import test from "node:test";

import { PreparingAction, advancePreparingLease } from "./renter-pod-activation.mjs";

function harness(kamiState) {
  const calls = [];
  return {
    calls,
    args: {
      reconcileStrategy: async () => calls.push("arm"),
      readKamiState: async () => {
        calls.push("read-state");
        return kamiState;
      },
      activateLease: async () => calls.push("activate"),
    },
  };
}

test("an armed RESTING Kami does not start the paid lease clock", async () => {
  const { calls, args } = harness("RESTING");
  assert.equal(await advancePreparingLease(args), PreparingAction.WAIT_FOR_FARMING);
  assert.deepEqual(calls, ["arm", "read-state"]);
});

test("the paid clock starts only after fresh chain state proves HARVESTING", async () => {
  const { calls, args } = harness("HARVESTING");
  assert.equal(await advancePreparingLease(args), PreparingAction.ACTIVATE);
  assert.deepEqual(calls, ["arm", "read-state", "activate"]);
});

test("unexpected non-farming states fail closed", async () => {
  for (const state of ["DEAD", "721_EXTERNAL", ""]) {
    const { calls, args } = harness(state);
    assert.equal(await advancePreparingLease(args), PreparingAction.WAIT_FOR_FARMING);
    assert.deepEqual(calls, ["arm", "read-state"]);
  }
});

test("a failed state read cannot activate the lease", async () => {
  const calls = [];
  await assert.rejects(
    advancePreparingLease({
      reconcileStrategy: async () => calls.push("arm"),
      readKamiState: async () => {
        calls.push("read-state");
        throw new Error("rpc unavailable");
      },
      activateLease: async () => calls.push("activate"),
    }),
    /rpc unavailable/
  );
  assert.deepEqual(calls, ["arm", "read-state"]);
});
