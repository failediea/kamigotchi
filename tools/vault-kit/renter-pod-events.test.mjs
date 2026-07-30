import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCanonicalCheckpoint,
  assertCursorSequence,
  checkpointForBlock,
  eventIdentity,
} from "./renter-pod-events.mjs";

const A = `0x${"11".repeat(32)}`;
const B = `0x${"22".repeat(32)}`;

test("event identity retains canonical block, transaction, and log index", () => {
  assert.deepEqual(
    eventIdentity({ blockHash: A, transactionHash: B, index: 7 }),
    { blockHash: A, transactionHash: B, index: 7, id: `${B}:7` }
  );
});

test("matching cursor checkpoint is accepted", () => {
  const stored = checkpointForBlock({ number: 50, hash: A });
  assert.doesNotThrow(() =>
    assertCanonicalCheckpoint(stored, { number: 50, hash: A })
  );
  assert.doesNotThrow(() => assertCursorSequence(51, stored));
});

test("changed canonical hash fails closed with reconciliation guidance", () => {
  const stored = checkpointForBlock({ number: 50, hash: A });
  assert.throws(
    () => assertCanonicalCheckpoint(stored, { number: 50, hash: B }),
    /stop and reconcile reservations\/jobs/
  );
});

test("missing canonical checkpoint fails closed", () => {
  const stored = checkpointForBlock({ number: 50, hash: A });
  assert.throws(
    () => assertCanonicalCheckpoint(stored, null),
    /unavailable; stop and reconcile worker state/
  );
});

test("inconsistent next-block cursor fails closed", () => {
  const stored = checkpointForBlock({ number: 50, hash: A });
  assert.throws(
    () => assertCursorSequence(52, stored),
    /cursor is inconsistent/
  );
});

test("malformed event identities are rejected", () => {
  assert.throws(
    () => eventIdentity({ blockHash: "0x1", transactionHash: B, index: 0 }),
    /invalid event block hash/
  );
});
