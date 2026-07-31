import assert from "node:assert/strict";
import test from "node:test";
import { EndingAction } from "./renter-pod-recovery.mjs";
import { advanceEndingLease } from "./renter-pod-ending.mjs";

function harness(kamiState, { stopError } = {}) {
  const calls = [];
  return {
    calls,
    args: {
      tokenIndex: 10165,
      stopStrategy: async () => calls.push("stop-strategy"),
      readKamiState: async () => {
        calls.push("read-state");
        return kamiState;
      },
      stopHarvest: async () => {
        calls.push("stop-harvest");
        if (stopError) throw stopError;
      },
      finalizeLease: async () => calls.push("finalize"),
      markFinalized: async () => calls.push("mark-finalized"),
    },
  };
}

test("ending while harvesting stops on-chain and does not finalize in the same tick", async () => {
  const { calls, args } = harness("HARVESTING");
  assert.equal(await advanceEndingLease(args), EndingAction.STOP_HARVEST);
  assert.deepEqual(calls, ["stop-strategy", "read-state", "stop-harvest"]);
});

test("a failed harvest stop cannot cascade into finalization", async () => {
  const { calls, args } = harness("HARVESTING", { stopError: new Error("cooldown") });
  await assert.rejects(advanceEndingLease(args), /cooldown/);
  assert.deepEqual(calls, ["stop-strategy", "read-state", "stop-harvest"]);
});

test("ending finalizes only after a fresh RESTING read", async () => {
  const { calls, args } = harness("RESTING");
  assert.equal(await advanceEndingLease(args), EndingAction.FINALIZE);
  assert.deepEqual(calls, ["stop-strategy", "read-state", "finalize", "mark-finalized"]);
});

test("unexpected states fail closed without harvest stop or finalization", async () => {
  const { calls, args } = harness("DEAD");
  await assert.rejects(advanceEndingLease(args), /unexpected on-chain state DEAD/);
  assert.deepEqual(calls, ["stop-strategy", "read-state"]);
});
