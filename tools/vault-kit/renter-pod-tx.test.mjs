import assert from "node:assert/strict";
import test from "node:test";
import { TxPendingError, TxTimeoutError, createTxTracker } from "./renter-pod-tx.mjs";

const HASH = `0x${"ab".repeat(32)}`;

function fakeProvider({ receipts = new Map(), mempool = new Set() } = {}) {
  return {
    receipts,
    mempool,
    getTransactionReceipt: async (hash) => receipts.get(hash) ?? null,
    getTransaction: async (hash) => (mempool.has(hash) ? { hash } : null),
  };
}

function fakeTx({ hash = HASH, nonce = 9, outcome }) {
  return {
    hash,
    nonce,
    from: "0x0000000000000000000000000000000000000abc",
    waits: [],
    async wait(confirms, timeout) {
      this.waits.push([confirms, timeout]);
      return outcome();
    },
  };
}

function timeoutError() {
  const error = new Error("wait for transaction timeout");
  error.code = "TIMEOUT";
  return error;
}

test("every wait carries the configured timeout and success clears the record", async () => {
  const state = {};
  const persisted = [];
  const tracker = createTxTracker({
    state,
    provider: fakeProvider(),
    timeoutMs: 120_000,
    persist: () => persisted.push(JSON.stringify(state.pendingTxs)),
  });
  const tx = fakeTx({ outcome: () => ({ status: 1 }) });
  const receipt = await tracker.send("7:0x1", "endLease", async () => tx);
  assert.deepEqual(receipt, { status: 1 });
  assert.deepEqual(tx.waits, [[1, 120_000]]);
  assert.match(persisted[0], new RegExp(HASH), "pending tx is persisted BEFORE waiting");
  assert.deepEqual(state.pendingTxs, {});
});

test("timeout alerts TX_TIMEOUT, keeps the tx remembered, and blocks a duplicate send", async () => {
  const state = {};
  const provider = fakeProvider();
  provider.mempool.add(HASH);
  const alerts = [];
  const tracker = createTxTracker({
    state,
    provider,
    timeoutMs: 1_000,
    alert: (code, details) => alerts.push({ code, details }),
  });
  await assert.rejects(
    tracker.send("7:0x1", "markLeasePreparing", async () => fakeTx({ outcome: () => { throw timeoutError(); } })),
    TxTimeoutError
  );
  assert.equal(alerts[0].code, "TX_TIMEOUT");
  assert.equal(alerts[0].details.hash, HASH);
  assert.equal(alerts[0].details.nonce, 9);
  assert.equal(state.pendingTxs["7:0x1"].label, "markLeasePreparing");

  let sent = false;
  await assert.rejects(
    tracker.send("7:0x1", "markLeasePreparing", async () => {
      sent = true;
      return fakeTx({ outcome: () => ({}) });
    }),
    TxPendingError
  );
  assert.equal(sent, false, "no second tx while the first is still in the mempool");
  assert.equal(alerts.at(-1).details.state, "still-pending");

  // A different job is unaffected.
  await tracker.send("9:0x2", "endLease", async () => fakeTx({ hash: `0x${"cd".repeat(32)}`, outcome: () => ({}) }));
});

test("a timed-out tx that later mined is cleared from its receipt", async () => {
  const state = { pendingTxs: { "7:0x1": { hash: HASH, nonce: 9, from: "0x1", label: "x", sentAt: 0 } } };
  const provider = fakeProvider();
  provider.receipts.set(HASH, { status: 1 });
  const tracker = createTxTracker({ state, provider, timeoutMs: 1_000 });
  assert.equal(await tracker.pendingFor("7:0x1"), null);
  assert.deepEqual(state.pendingTxs, {});
});

test("a dropped tx (unknown, never mined) is cleared so the job can resend", async () => {
  const state = { pendingTxs: { "7:0x1": { hash: HASH, nonce: 9, from: "0x1", label: "x", sentAt: 0 } } };
  const tracker = createTxTracker({ state, provider: fakeProvider(), timeoutMs: 1_000 });
  const tx = fakeTx({ hash: `0x${"ef".repeat(32)}`, outcome: () => ({ status: 1 }) });
  await tracker.send("7:0x1", "x", async () => tx);
  assert.deepEqual(state.pendingTxs, {});
});

test("revert is a definite outcome (cleared); an RPC error mid-wait is not (kept)", async () => {
  const state = {};
  const tracker = createTxTracker({ state, provider: fakeProvider(), timeoutMs: 1_000 });
  const revert = Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" });
  await assert.rejects(tracker.send("a", "x", async () => fakeTx({ outcome: () => { throw revert; } })), /reverted/);
  assert.equal(state.pendingTxs.a, undefined);

  const flake = Object.assign(new Error("socket hang up"), { code: "NETWORK_ERROR" });
  await assert.rejects(tracker.send("b", "x", async () => fakeTx({ outcome: () => { throw flake; } })), /socket/);
  assert.equal(state.pendingTxs.b.hash, HASH, "unknown outcome stays tracked");
});

test("persisted pending txs survive a restart (new tracker, same state)", async () => {
  const state = {};
  const provider = fakeProvider();
  provider.mempool.add(HASH);
  const first = createTxTracker({ state, provider, timeoutMs: 1_000 });
  await assert.rejects(first.send("7:0x1", "x", async () => fakeTx({ outcome: () => { throw timeoutError(); } })));
  const restarted = createTxTracker({ state: JSON.parse(JSON.stringify(state)), provider, timeoutMs: 1_000 });
  assert.ok(await restarted.pendingFor("7:0x1"));
});

test("timeout must be positive", () => {
  assert.throws(() => createTxTracker({ state: {}, provider: fakeProvider(), timeoutMs: 0 }), /positive/);
});
