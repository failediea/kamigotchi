import assert from "node:assert/strict";
import test from "node:test";
import { Wallet, keccak256 } from "ethers";
import { TxPendingError, TxTimeoutError, createTxTracker, isDefiniteBroadcastRejection } from "./renter-pod-tx.mjs";

const FROM = "0x0000000000000000000000000000000000000abc";
const OTHER_HASH = `0x${"ab".repeat(32)}`;

function fakeSigner({ address = FROM, nonce = 9 } = {}) {
  let serial = 0;
  return {
    address,
    populated: [],
    async populateTransaction(tx) {
      const populated = { ...tx, nonce: tx.nonce ?? nonce };
      this.populated.push(populated);
      return populated;
    },
    async signTransaction(tx) {
      serial++;
      const body = JSON.stringify({ ...tx, serial }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      return `0x${Buffer.from(body).toString("hex")}`;
    },
  };
}

/**
 * Fake node. `onBroadcast(raw, hash)` decides what a broadcast does: return
 * a wait outcome function, or throw to fail the broadcast.
 */
function fakeProvider({ latestNonce = 0, onBroadcast } = {}) {
  const provider = {
    receipts: new Map(),
    mempool: new Set(),
    broadcasts: [],
    latestNonce,
    getTransactionReceipt: async (hash) => provider.receipts.get(hash) ?? null,
    getTransaction: async (hash) => (provider.mempool.has(hash) ? { hash } : null),
    getTransactionCount: async () => provider.latestNonce,
    broadcastTransaction: async (raw) => {
      const hash = keccak256(raw);
      provider.broadcasts.push(hash);
      const outcome = onBroadcast ? await onBroadcast(raw, hash) : () => ({ status: 1, hash });
      provider.mempool.add(hash);
      return {
        hash,
        waits: [],
        async wait(confirms, timeout) {
          this.waits.push([confirms, timeout]);
          return outcome();
        },
      };
    },
  };
  return provider;
}

const request = { to: "0x00000000000000000000000000000000000000f1", data: "0x1234" };

function timeoutError() {
  return Object.assign(new Error("wait for transaction timeout"), { code: "TIMEOUT" });
}

test("tx is signed and persisted (with its raw bytes) BEFORE the broadcast; success clears it", async () => {
  const state = {};
  const persisted = [];
  const provider = fakeProvider();
  const signer = fakeSigner();
  const tracker = createTxTracker({
    state,
    provider,
    timeoutMs: 120_000,
    persist: () => persisted.push({ records: JSON.parse(JSON.stringify(state.pendingTxs)), broadcasts: provider.broadcasts.length }),
  });
  const receipt = await tracker.send("7:0x1", "endLease", { signer, request });
  assert.equal(receipt.status, 1);
  const first = persisted[0];
  assert.equal(first.broadcasts, 0, "persisted before anything reached the node");
  const record = first.records["7:0x1"];
  assert.equal(record.hash, provider.broadcasts[0]);
  assert.equal(record.nonce, 9);
  assert.equal(record.from, FROM);
  assert.equal(keccak256(record.raw), record.hash);
  assert.deepEqual(state.pendingTxs, {});
});

test("record hash matches ethers' own hash for a real signed tx", async () => {
  const wallet = Wallet.createRandom();
  const raw = await wallet.signTransaction({ to: request.to, data: "0x", nonce: 3, gasLimit: 21000n, gasPrice: 2_500_000n, chainId: 1n, type: 0 });
  const { Transaction } = await import("ethers");
  assert.equal(keccak256(raw), Transaction.from(raw).hash);
});

test("broadcast timeout gap: node accepted the tx but the RPC call timed out -> no second send", async () => {
  const state = {};
  const provider = fakeProvider({
    onBroadcast: (_raw, hash) => {
      provider.mempool.add(hash); // the node DID accept it ...
      throw Object.assign(new Error("request timeout"), { code: "TIMEOUT" }); // ... but the client gave up
    },
  });
  const tracker = createTxTracker({ state, provider, timeoutMs: 1_000 });
  await assert.rejects(tracker.send("7:0x1", "pullGas", { signer: fakeSigner(), request }), /timeout/);
  const recorded = state.pendingTxs["7:0x1"];
  assert.ok(recorded, "ambiguous broadcast keeps the record");

  // Next tick: the re-derived pullGas must NOT go out while the first is pending.
  const signer = fakeSigner({ nonce: 10 });
  await assert.rejects(tracker.send("7:0x1", "pullGas", { signer, request }), TxPendingError);
  assert.equal(signer.populated.length, 0, "nothing signed for the duplicate");
});

test("definite broadcast rejections forget the tx at once", async () => {
  const state = {};
  const provider = fakeProvider({
    onBroadcast: () => {
      throw Object.assign(new Error("insufficient funds for gas * price + value"), { code: "INSUFFICIENT_FUNDS" });
    },
  });
  const tracker = createTxTracker({ state, provider, timeoutMs: 1_000 });
  await assert.rejects(tracker.send("7:0x1", "kamiSend", { signer: fakeSigner(), request }), /insufficient/);
  assert.deepEqual(state.pendingTxs, {});
  assert.equal(isDefiniteBroadcastRejection(new Error("nonce too low")), true);
  assert.equal(isDefiniteBroadcastRejection(Object.assign(new Error("socket hang up"), { code: "NETWORK_ERROR" })), false);
});

test("timeout alerts TX_TIMEOUT, keeps the tx remembered, and blocks a duplicate send", async () => {
  const state = {};
  const provider = fakeProvider({ onBroadcast: () => () => { throw timeoutError(); } });
  const alerts = [];
  const tracker = createTxTracker({
    state,
    provider,
    timeoutMs: 1_000,
    alert: (code, details) => alerts.push({ code, details }),
  });
  await assert.rejects(tracker.send("7:0x1", "markLeasePreparing", { signer: fakeSigner(), request }), TxTimeoutError);
  assert.equal(alerts[0].code, "TX_TIMEOUT");
  assert.equal(alerts[0].details.nonce, 9);
  assert.equal(state.pendingTxs["7:0x1"].label, "markLeasePreparing");

  const again = fakeSigner();
  await assert.rejects(tracker.send("7:0x1", "markLeasePreparing", { signer: again, request }), TxPendingError);
  assert.equal(again.populated.length, 0, "no second tx while the first is still in the mempool");
  assert.equal(alerts.at(-1).details.state, "still-pending");

  // A different job is unaffected.
  const okProvider = fakeProvider();
  const other = createTxTracker({ state, provider: okProvider, timeoutMs: 1_000 });
  await other.send("9:0x2", "endLease", { signer: fakeSigner(), request });
});

test("a timed-out tx that later mined is cleared from its receipt", async () => {
  const state = { pendingTxs: { "7:0x1": { hash: OTHER_HASH, nonce: 9, from: FROM, label: "x", sentAt: 0 } } };
  const provider = fakeProvider();
  provider.receipts.set(OTHER_HASH, { status: 1 });
  const tracker = createTxTracker({ state, provider, timeoutMs: 1_000 });
  assert.equal(await tracker.pendingFor("7:0x1"), null);
  assert.deepEqual(state.pendingTxs, {});
});

test("unseen tx whose nonce is consumed (mined/replaced, receipt lagging) is cleared", async () => {
  const state = { pendingTxs: { "7:0x1": { hash: OTHER_HASH, nonce: 9, from: FROM, label: "x", sentAt: 0 } } };
  const provider = fakeProvider({ latestNonce: 10 });
  const tracker = createTxTracker({ state, provider, timeoutMs: 1_000 });
  assert.equal(await tracker.pendingFor("7:0x1"), null);
  assert.deepEqual(state.pendingTxs, {});
});

test("a null getTransaction alone never frees the job: rebroadcast, wait, then reuse the SAME nonce", async () => {
  let clock = 0;
  const state = {};
  const provider = fakeProvider({ latestNonce: 9 });
  provider.getTransaction = async () => null; // flaky/lagging node never shows it
  const tracker = createTxTracker({ state, provider, timeoutMs: 1_000, dropAfterMs: 5_000, now: () => clock });
  const raw = `0x${"12".repeat(40)}`;
  const hash = keccak256(raw);
  state.pendingTxs["7:0x1"] = { hash, nonce: 9, from: FROM, label: "pullGas", sentAt: 0, raw };

  const held = await tracker.pendingFor("7:0x1");
  assert.ok(held, "unseen but nonce free: still treated as pending");
  assert.deepEqual(provider.broadcasts, [hash], "the stored raw tx was rebroadcast (same hash)");
  const signer = fakeSigner({ nonce: 10 });
  await assert.rejects(tracker.send("7:0x1", "pullGas", { signer, request }), TxPendingError);

  clock = 6_000;
  assert.equal(await tracker.pendingFor("7:0x1"), null, "declared dropped after dropAfterMs");
  assert.deepEqual(state.txNonceHints["7:0x1"], { from: FROM, nonce: 9, label: "pullGas", at: 6_000 });

  // The node's pending count says 10 (it may still hold the original), but the
  // resend is pinned to nonce 9: the original and the retry cannot both mine.
  await tracker.send("7:0x1", "pullGas", { signer, request });
  assert.equal(signer.populated[0].nonce, 9);
  assert.equal(state.txNonceHints["7:0x1"], undefined);
});

test("a nonce hint from another address, or an already-consumed one, is ignored", async () => {
  const state = { txNonceHints: { a: { from: "0x0000000000000000000000000000000000000def", nonce: 4 }, b: { from: FROM, nonce: 4 } } };
  const provider = fakeProvider({ latestNonce: 5 });
  const tracker = createTxTracker({ state, provider, timeoutMs: 1_000 });
  const signerA = fakeSigner();
  await tracker.send("a", "x", { signer: signerA, request });
  assert.equal(signerA.populated[0].nonce, 9, "hint belongs to another signer");
  const signerB = fakeSigner();
  await tracker.send("b", "x", { signer: signerB, request });
  assert.equal(signerB.populated[0].nonce, 9, "hinted nonce already consumed on-chain");
  assert.equal(state.txNonceHints.b, undefined);
});

test("revert is a definite outcome (cleared); an RPC error mid-wait is not (kept)", async () => {
  const state = {};
  const revert = Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" });
  const reverting = createTxTracker({ state, provider: fakeProvider({ onBroadcast: () => () => { throw revert; } }), timeoutMs: 1_000 });
  await assert.rejects(reverting.send("a", "x", { signer: fakeSigner(), request }), /reverted/);
  assert.equal(state.pendingTxs.a, undefined);

  const flake = Object.assign(new Error("socket hang up"), { code: "NETWORK_ERROR" });
  const flaky = createTxTracker({ state, provider: fakeProvider({ onBroadcast: () => () => { throw flake; } }), timeoutMs: 1_000 });
  await assert.rejects(flaky.send("b", "x", { signer: fakeSigner(), request }), /socket/);
  assert.ok(state.pendingTxs.b.hash, "unknown outcome stays tracked");
});

test("preflight runs before signing and can abort the send", async () => {
  const state = {};
  const signer = fakeSigner();
  const tracker = createTxTracker({ state, provider: fakeProvider(), timeoutMs: 1_000 });
  await assert.rejects(
    tracker.send("a", "markLeasePreparing", { signer, request, preflight: async () => { throw new Error("request moved to another pod"); } }),
    /another pod/
  );
  assert.equal(signer.populated.length, 0);
  assert.deepEqual(state.pendingTxs, {});
});

test("fee policy overrides apply unless the request prices itself", async () => {
  const state = {};
  const tracker = createTxTracker({
    state,
    provider: fakeProvider(),
    timeoutMs: 1_000,
    feeOverrides: async () => ({ type: 0, gasPrice: 7n }),
  });
  const signer = fakeSigner();
  await tracker.send("a", "x", { signer, request });
  assert.equal(signer.populated[0].type, 0);
  assert.equal(signer.populated[0].gasPrice, 7n);
  await tracker.send("b", "returnGas", { signer, request: { ...request, gasPrice: 9n } });
  assert.equal(signer.populated[1].gasPrice, 9n);
});

test("persisted pending txs survive a restart (new tracker, same state)", async () => {
  const state = {};
  const provider = fakeProvider({ onBroadcast: () => () => { throw timeoutError(); } });
  const first = createTxTracker({ state, provider, timeoutMs: 1_000 });
  await assert.rejects(first.send("7:0x1", "x", { signer: fakeSigner(), request }));
  const restarted = createTxTracker({ state: JSON.parse(JSON.stringify(state)), provider, timeoutMs: 1_000 });
  assert.ok(await restarted.pendingFor("7:0x1"));
});

test("timeout must be positive", () => {
  assert.throws(() => createTxTracker({ state: {}, provider: fakeProvider(), timeoutMs: 0 }), /positive/);
});
