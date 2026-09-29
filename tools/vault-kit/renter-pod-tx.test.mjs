import assert from "node:assert/strict";
import test from "node:test";
import { Wallet, keccak256 } from "ethers";
import {
  TxPendingError,
  TxTimeoutError,
  createTxTracker,
  isDefiniteBroadcastRejection,
  isNonceHeldByMempool,
} from "./renter-pod-tx.mjs";

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
  const hint = state.txNonceHints["7:0x1"];
  assert.deepEqual({ ...hint, prevRecord: undefined }, { from: FROM, nonce: 9, label: "pullGas", at: 6_000, prevRecord: undefined });
  assert.equal(hint.prevRecord.hash, hash, "the dropped record is kept on the hint");

  // The node's pending count says 10 (it may still hold the original), but the
  // resend is pinned to nonce 9: the original and the retry cannot both mine.
  await tracker.send("7:0x1", "pullGas", { signer, request });
  assert.equal(signer.populated[0].nonce, 9);
  assert.ok(state.txNonceHints["7:0x1"], "hint kept until the latest nonce passes it");

  // Nonce 9 mined: the next send for this job drops the hint and uses the node nonce.
  provider.latestNonce = 10;
  await tracker.send("7:0x1", "pullGas", { signer, request });
  assert.equal(signer.populated[1].nonce, 10);
  assert.equal(state.txNonceHints["7:0x1"], undefined);
});

/**
 * Node that accepts txs into a mempool it hides from eth_getTransactionByHash
 * and answers geth-style: "already known" for the same bytes, "replacement
 * transaction underpriced" for other bytes at an occupied nonce. The mempool
 * is keyed by nonce, like a real txpool for one sender.
 */
function hidingNode({ latestNonce = 9, acceptFirstButTimeOut = true } = {}) {
  const pool = new Map(); // nonce -> hash
  const node = {
    pool,
    latestNonce,
    broadcasts: [],
    getTransactionReceipt: async () => null,
    getTransaction: async () => null,
    getTransactionCount: async (_from, tag) => (tag === "pending" ? node.latestNonce + pool.size : node.latestNonce),
    broadcastTransaction: async (raw) => {
      const hash = keccak256(raw);
      const nonce = JSON.parse(Buffer.from(raw.slice(2), "hex").toString()).nonce;
      node.broadcasts.push({ hash, nonce });
      if (pool.get(nonce) === hash) {
        throw Object.assign(new Error('could not coalesce error (error={ "code": -32000, "message": "already known" })'), {
          code: "UNKNOWN_ERROR",
          error: { code: -32000, message: "already known" },
        });
      }
      if (pool.has(nonce)) {
        throw Object.assign(new Error("replacement fee too low"), { code: "REPLACEMENT_UNDERPRICED" });
      }
      pool.set(nonce, hash);
      if (acceptFirstButTimeOut && pool.size === 1 && node.broadcasts.length === 1) {
        throw Object.assign(new Error("request timeout"), { code: "TIMEOUT" });
      }
      return { hash, async wait() { throw timeoutError(); } };
    },
  };
  return node;
}

test("final-verify repro: a hidden-mempool pullGas answered 'already known' is never declared dropped", async () => {
  let clock = 0;
  const state = {};
  const node = hidingNode();
  const tracker = createTxTracker({ state, provider: node, timeoutMs: 120_000, now: () => clock });
  // 1. Accepted by the node, but the client-side broadcast times out.
  await assert.rejects(tracker.send("7:0x1", "pullGas", { signer: fakeSigner({ nonce: 9 }), request }), /timeout/);
  // 2-3. Every later check rebroadcasts; "already known" is proof it is pending.
  for (clock = 30_000; clock <= 900_000; clock += 30_000) {
    const pending = await tracker.pendingFor("7:0x1");
    assert.ok(pending, `still pending at ${clock} ms`);
    assert.equal(pending.unseenSince, undefined);
  }
  assert.equal(state.txNonceHints["7:0x1"], undefined, "never declared dropped");
  const next = fakeSigner({ nonce: 10 });
  await assert.rejects(tracker.send("7:0x1", "pullGas", { signer: next, request }), TxPendingError);
  assert.equal(next.populated.length, 0);
  assert.deepEqual([...node.pool.keys()], [9], "only one pullGas in the mempool");
});

test("final-verify repro: a resend refused as underpriced restores the original; nothing is ever signed at nonce+1", async () => {
  let clock = 0;
  const state = {};
  const node = hidingNode();
  // This node answers rebroadcasts with an opaque error (not "already known"),
  // so the tracker cannot see the original and declares it dropped.
  const realBroadcast = node.broadcastTransaction;
  let opaqueRebroadcasts = true;
  node.broadcastTransaction = async (raw) => {
    const first = state.pendingTxs?.["7:0x1"];
    if (opaqueRebroadcasts && first && keccak256(raw) === first.hash && node.broadcasts.length) {
      node.broadcasts.push({ hash: first.hash, nonce: first.nonce });
      throw Object.assign(new Error("503 upstream"), { code: "SERVER_ERROR" });
    }
    return realBroadcast(raw);
  };
  const tracker = createTxTracker({ state, provider: node, timeoutMs: 120_000, now: () => clock });
  await assert.rejects(tracker.send("7:0x1", "pullGas", { signer: fakeSigner({ nonce: 9 }), request }), /timeout/);
  const original = state.pendingTxs["7:0x1"].hash;
  clock = 30_000;
  assert.ok(await tracker.pendingFor("7:0x1"));
  clock = 300_000; // > dropAfterMs (240 s) unseen
  assert.equal(await tracker.pendingFor("7:0x1"), null, "declared dropped");
  opaqueRebroadcasts = false;

  // 4-5. The resend (new amount, new hash) is pinned to nonce 9 and refused as
  // underpriced: the original is restored, the hint is kept.
  const resend = fakeSigner({ nonce: 10 });
  await assert.rejects(tracker.send("7:0x1", "pullGas", { signer: resend, request }), TxPendingError);
  assert.equal(resend.populated[0].nonce, 9);
  assert.equal(state.pendingTxs["7:0x1"].hash, original, "original record restored");
  assert.equal(state.txNonceHints["7:0x1"].nonce, 9, "hint kept");

  // 6. Next ticks: the restored original rebroadcasts as "already known" and
  // keeps the job paused; no tx at nonce 10 is ever signed.
  for (clock = 330_000; clock <= 1_200_000; clock += 30_000) {
    assert.ok(await tracker.pendingFor("7:0x1"));
    await assert.rejects(tracker.send("7:0x1", "pullGas", { signer: resend, request }), TxPendingError);
  }
  assert.equal(resend.populated.length, 1, "only the refused nonce-9 resend was ever signed");
  assert.deepEqual([...node.pool.keys()], [9], "a single pullGas can mine");

  // The original finally mines: the job is free and the hint is gone.
  node.pool.clear();
  node.latestNonce = 10;
  assert.equal(await tracker.pendingFor("7:0x1"), null);
  await tracker.send("7:0x1", "pullGas", { signer: resend, request }).catch(() => {});
  assert.equal(resend.populated.at(-1).nonce, 10);
  assert.equal(state.txNonceHints["7:0x1"], undefined);
});

test("a dormant record (unchecked for longer than dormantAfterMs, e.g. across a rollback) is never rebroadcast", async () => {
  let clock = 3 * 60 * 60_000;
  const provider = fakeProvider({ latestNonce: 9 });
  provider.getTransaction = async () => null;
  const raw = `0x${"34".repeat(40)}`;
  const state = {
    pendingTxs: { "7:0x1": { hash: keccak256(raw), nonce: 9, from: FROM, label: "move:12", sentAt: 0, raw } },
  };
  const alerts = [];
  const tracker = createTxTracker({
    state,
    provider,
    timeoutMs: 1_000,
    dropAfterMs: 5_000,
    now: () => clock,
    alert: (code, details) => alerts.push({ code, details }),
  });
  assert.ok(await tracker.pendingFor("7:0x1"), "still unresolved: wait, but do not replay stale bytes");
  assert.deepEqual(provider.broadcasts, []);
  assert.equal(alerts.at(-1).details.state, "unseen-dormant");
  clock += 1_000;
  assert.ok(await tracker.pendingFor("7:0x1"));
  assert.deepEqual(provider.broadcasts, [], "stays no-rebroadcast once dormant");
  clock += 5_000;
  assert.equal(await tracker.pendingFor("7:0x1"), null, "dropped after dropAfterMs");
  assert.equal(state.txNonceHints["7:0x1"].nonce, 9, "its nonce is pinned for the re-derived send");

  // A record checked recently is not dormant: it is rebroadcast as before.
  const fresh = { pendingTxs: { a: { hash: keccak256(raw), nonce: 9, from: FROM, label: "x", sentAt: clock - 10_000, raw } } };
  const freshTracker = createTxTracker({ state: fresh, provider, timeoutMs: 1_000, dropAfterMs: 5_000, now: () => clock });
  await freshTracker.pendingFor("a");
  assert.equal(provider.broadcasts.length, 1);
  assert.throws(() => createTxTracker({ state: {}, provider, timeoutMs: 1_000, dropAfterMs: 5_000, dormantAfterMs: 5_000 }), /dormant/);
});

test("isNonceHeldByMempool recognises already-known and underpriced refusals only", () => {
  assert.equal(isNonceHeldByMempool(Object.assign(new Error("x"), { code: "REPLACEMENT_UNDERPRICED" })), true);
  assert.equal(isNonceHeldByMempool({ message: "could not coalesce", info: { error: { message: "already known" } } }), true);
  assert.equal(isNonceHeldByMempool(new Error("known transaction: 0xabc")), true);
  assert.equal(isNonceHeldByMempool(new Error("nonce too low")), false);
  assert.equal(isNonceHeldByMempool(Object.assign(new Error("socket hang up"), { code: "NETWORK_ERROR" })), false);
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
