import test from "node:test";
import assert from "node:assert/strict";
import { returnCheckDue, recordReturnState } from "./legacy-return-state.mjs";

test("a dead return is persisted, never sent, and retries only a state read after 15 minutes", () => {
  const state = {};
  assert.equal(returnCheckDue(state, 16218, 100), true);
  assert.deepEqual(recordReturnState(state, 16218, "DEAD", 100), { send: false, changed: true, notify: true, reason: "DEAD" });
  assert.equal(returnCheckDue(JSON.parse(JSON.stringify(state)), 16218, 30_100), false);
  assert.equal(returnCheckDue(state, 16218, 900_100), true);
  assert.equal(recordReturnState(state, 16218, "DEAD", 900_100).notify, false);
  assert.equal(recordReturnState(state, 16218, "DEAD", 3_600_100).notify, true);
});

test("the latch is per Kami and clears only after a fresh RESTING read", () => {
  const state = {};
  recordReturnState(state, 1, "DEAD", 100);
  assert.equal(returnCheckDue(state, 2, 100), true);
  assert.equal(recordReturnState(state, 1, null, 1000).send, false);
  assert.equal(recordReturnState(state, 1, "HARVESTING", 2000).send, false);
  assert.equal(recordReturnState(state, 1, "RESTING", 3000).send, true);
  assert.equal(state.blockedReturns[1], undefined);
});
