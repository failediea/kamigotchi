import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import {
  RetiredJobAction,
  applyRenterPodEvent,
  ingestRenterPodRecords,
  protectedReservationNonces,
  renterPodEventRecord,
  requestBelongsToOtherPod,
  retiredJobAction,
  retiredJobKey,
} from "./renter-pod-ingest.mjs";
import { reserveRandomOperator } from "./renter-pod-keys.mjs";
import { runWorkerTick } from "./renter-pod-tick.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const hex64 = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (n) => `0x${n.toString(16).padStart(40, "0")}`;

/** A reserved nonce plus the RenterPodCreated record that would claim it. */
function quotedPod(state, { token, nonceSeed, podSeed, block, index = 0, renter = addr(0xabc) }) {
  const nonce = hex64(nonceSeed);
  const { operator } = reserveRandomOperator(state, nonce, { now: 1_000 });
  return {
    tokenIndex: token,
    renter,
    node: 42,
    pod: addr(podSeed),
    operator,
    nonce,
    eventBlock: block,
    eventBlockHash: hex64(block + 1_000_000),
    eventTransactionHash: hex64(block * 100 + index + 7),
    eventIndex: index,
    eventId: `${hex64(block * 100 + index + 7)}:${index}`,
  };
}

function freshState() {
  return { lastBlock: 100, jobs: {}, reservations: {} };
}

/** readRequestPod backed by a mutable map (token -> current factory pod). */
function chain(initial = {}) {
  const pods = new Map(Object.entries(initial).map(([k, v]) => [Number(k), v]));
  const reads = [];
  return {
    pods,
    reads,
    readRequestPod: async (token) => {
      reads.push(token);
      return pods.get(Number(token)) ?? ZERO;
    },
  };
}

test("event record keeps the same identity fields the worker always stored", () => {
  const tx = hex64(0x77);
  const record = renterPodEventRecord({
    args: {
      renter: addr(1),
      tokenIndex: 7n,
      nodeIndex: 42n,
      pod: addr(2),
      operator: addr(3),
      nonce: hex64(5),
    },
    blockNumber: 123,
    blockHash: hex64(0x99),
    transactionHash: tx,
    index: 4,
  });
  assert.deepEqual(record, {
    tokenIndex: 7,
    renter: addr(1),
    node: 42,
    pod: addr(2),
    operator: addr(3),
    nonce: hex64(5),
    eventBlock: 123,
    eventBlockHash: hex64(0x99),
    eventTransactionHash: tx,
    eventIndex: 4,
    eventId: `${tx}:4`,
  });
});

test("THR-01 regression: create -> cancel -> create in ONE ingest batch adopts the live pod and retires the old one", async () => {
  const state = freshState();
  const first = quotedPod(state, { token: 7, nonceSeed: 1, podSeed: 0xa1, block: 200, index: 0 });
  const second = quotedPod(state, { token: 7, nonceSeed: 2, podSeed: 0xa2, block: 201, index: 0 });
  const rpc = chain({ 7: second.pod });

  const { outcomes, claimedNonces } = await ingestRenterPodRecords(state, [first, second], {
    readRequestPod: rpc.readRequestPod,
    nowMs: 5_000,
  });

  assert.deepEqual(outcomes.map((o) => o.outcome), ["adopted", "superseded-existing"]);
  assert.equal(state.jobs[7].nonce, second.nonce);
  assert.equal(state.jobs[7].pod, second.pod);
  assert.equal(state.jobs[7].returned, false);
  assert.ok(state.jobs[7].operatorKey, "live job holds its operator key");
  const retired = state.retiredJobs[retiredJobKey(first)];
  assert.equal(retired.pod, first.pod);
  assert.equal(retired.retired, true);
  assert.equal(retired.retiredReason, "superseded");
  assert.equal(retired.supersededBy, second.nonce);
  assert.equal(retired.returned, false, "retired job still gets its stage-zero style return check");
  assert.deepEqual(claimedNonces, [first.nonce, second.nonce]);
  assert.deepEqual(state.ingestRetry, {});
  // Reservations are resolved but only deleted after the state file is saved.
  assert.ok(state.reservations[first.nonce] && state.reservations[second.nonce]);
});

test("THR-01 regression: create -> cancel -> create in SEPARATE batches", async () => {
  const state = freshState();
  const first = quotedPod(state, { token: 7, nonceSeed: 1, podSeed: 0xa1, block: 200 });
  const rpc = chain({ 7: first.pod });
  await ingestRenterPodRecords(state, [first], { readRequestPod: rpc.readRequestPod, nowMs: 1 });
  assert.equal(state.jobs[7].nonce, first.nonce);
  assert.deepEqual(rpc.reads, [], "no chain read without a conflict");

  // Renter cancels and re-rents before the worker saw stage 0 for the first job.
  const second = quotedPod(state, { token: 7, nonceSeed: 2, podSeed: 0xa2, block: 260 });
  rpc.pods.set(7, second.pod);
  const { outcomes } = await ingestRenterPodRecords(state, [second], { readRequestPod: rpc.readRequestPod, nowMs: 2 });
  assert.deepEqual(outcomes.map((o) => o.outcome), ["superseded-existing"]);
  assert.equal(state.jobs[7].nonce, second.nonce);
  assert.ok(state.retiredJobs[retiredJobKey(first)]);
});

test("three creates for one Kami in one batch: only the factory's live pod stays active", async () => {
  const state = freshState();
  const a = quotedPod(state, { token: 7, nonceSeed: 1, podSeed: 0xa1, block: 200 });
  const b = quotedPod(state, { token: 7, nonceSeed: 2, podSeed: 0xa2, block: 200, index: 3 });
  const c = quotedPod(state, { token: 7, nonceSeed: 3, podSeed: 0xa3, block: 202 });
  const rpc = chain({ 7: c.pod });
  const { outcomes } = await ingestRenterPodRecords(state, [a, b, c], { readRequestPod: rpc.readRequestPod, nowMs: 1 });
  assert.deepEqual(outcomes.map((o) => o.outcome), ["adopted", "superseded-existing", "superseded-existing"]);
  assert.equal(state.jobs[7].pod, c.pod);
  assert.equal(Object.keys(state.retiredJobs).length, 2);
});

test("everything cancelled (factory request cleared): newest event is tracked, older retired", async () => {
  const state = freshState();
  const a = quotedPod(state, { token: 7, nonceSeed: 1, podSeed: 0xa1, block: 200 });
  const b = quotedPod(state, { token: 7, nonceSeed: 2, podSeed: 0xa2, block: 201 });
  const rpc = chain({});
  await ingestRenterPodRecords(state, [a, b], { readRequestPod: rpc.readRequestPod, nowMs: 1 });
  assert.equal(state.jobs[7].nonce, b.nonce);
  assert.ok(state.retiredJobs[retiredJobKey(a)]);
});

test("a failing token is parked for retry and every other token is still ingested", async () => {
  const state = freshState();
  const first = quotedPod(state, { token: 7, nonceSeed: 1, podSeed: 0xa1, block: 200 });
  await ingestRenterPodRecords(state, [first], { readRequestPod: chain().readRequestPod, nowMs: 1 });

  const second = quotedPod(state, { token: 7, nonceSeed: 2, podSeed: 0xa2, block: 300 });
  const other = quotedPod(state, { token: 9, nonceSeed: 3, podSeed: 0xb1, block: 301 });
  let rpcUp = false;
  const readRequestPod = async (token) => {
    if (!rpcUp) throw new Error("rpc: missing response");
    return token === 7 ? second.pod : other.pod;
  };
  const alerts = [];
  const { outcomes, claimedNonces } = await ingestRenterPodRecords(state, [second, other], {
    readRequestPod,
    nowMs: 10,
    alert: (code, details) => alerts.push({ code, details }),
  });
  assert.deepEqual(outcomes.map((o) => o.outcome), ["parked", "adopted"]);
  assert.equal(state.jobs[9].pod, other.pod, "token 9 is not blocked by token 7");
  assert.equal(state.jobs[7].nonce, first.nonce, "token 7's existing job is untouched");
  assert.deepEqual(claimedNonces, [other.nonce]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].code, "INGEST_ERROR");
  assert.equal(alerts[0].details.token, 7);
  assert.equal(state.ingestRetry[second.eventId].attempts, 1);
  assert.ok(protectedReservationNonces(state).has(second.nonce), "parked nonce's reservation is protected");

  // Later tick, no new events: the parked event is retried and applied.
  rpcUp = true;
  const retry = await ingestRenterPodRecords(state, [], { readRequestPod, nowMs: 20 });
  assert.deepEqual(retry.outcomes.map((o) => o.outcome), ["superseded-existing"]);
  assert.equal(state.jobs[7].nonce, second.nonce);
  assert.deepEqual(state.ingestRetry, {});
  assert.deepEqual(retry.claimedNonces, [second.nonce]);
});

test("a missing reservation parks only that event (it can never throw out of the batch)", async () => {
  const state = freshState();
  const orphan = quotedPod(state, { token: 7, nonceSeed: 1, podSeed: 0xa1, block: 200 });
  delete state.reservations[orphan.nonce];
  const other = quotedPod(state, { token: 9, nonceSeed: 2, podSeed: 0xb1, block: 201 });
  const { outcomes } = await ingestRenterPodRecords(state, [orphan, other], {
    readRequestPod: chain().readRequestPod,
    nowMs: 1,
  });
  assert.deepEqual(outcomes.map((o) => o.outcome), ["parked", "adopted"]);
  assert.match(state.ingestRetry[orphan.eventId].lastError, /reservation is missing/);
  assert.equal(state.jobs[7], undefined);
});

test("chain still reporting the OLD pod for a newer event is inconsistent: park, never overwrite", async () => {
  const state = freshState();
  const first = quotedPod(state, { token: 7, nonceSeed: 1, podSeed: 0xa1, block: 200 });
  const second = quotedPod(state, { token: 7, nonceSeed: 2, podSeed: 0xa2, block: 201 });
  const rpc = chain({ 7: first.pod });
  const { outcomes } = await ingestRenterPodRecords(state, [first, second], { readRequestPod: rpc.readRequestPod, nowMs: 1 });
  assert.deepEqual(outcomes.map((o) => o.outcome), ["adopted", "parked"]);
  assert.equal(state.jobs[7].nonce, first.nonce);
  assert.deepEqual(state.retiredJobs, {});
  assert.ok(state.reservations[second.nonce], "failed apply leaves the reservation in place");
});

test("an older parked event replayed after a newer job was adopted is retired, not adopted", async () => {
  const state = freshState();
  const old = quotedPod(state, { token: 7, nonceSeed: 1, podSeed: 0xa1, block: 200 });
  const current = quotedPod(state, { token: 7, nonceSeed: 2, podSeed: 0xa2, block: 300 });
  const other = quotedPod(state, { token: 7, nonceSeed: 3, podSeed: 0xa0, block: 100 });
  const rpc = chain({ 7: current.pod });
  await ingestRenterPodRecords(state, [old], { readRequestPod: rpc.readRequestPod, nowMs: 1 });
  await ingestRenterPodRecords(state, [current], { readRequestPod: rpc.readRequestPod, nowMs: 2 });
  const result = await applyRenterPodEvent(state, other, { readRequestPod: rpc.readRequestPod, nowMs: 3 });
  assert.equal(result.outcome, "retired-incoming");
  assert.equal(state.jobs[7].nonce, current.nonce);
  assert.equal(state.retiredJobs[retiredJobKey(other)].retiredReason, "stale-event");
});

test("re-ingesting a known event is a no-op", async () => {
  const state = freshState();
  const first = quotedPod(state, { token: 7, nonceSeed: 1, podSeed: 0xa1, block: 200 });
  await ingestRenterPodRecords(state, [first], { readRequestPod: chain().readRequestPod, nowMs: 1 });
  const again = await ingestRenterPodRecords(state, [first], { readRequestPod: chain().readRequestPod, nowMs: 2 });
  assert.deepEqual(again.outcomes.map((o) => o.outcome), ["duplicate"]);
  assert.deepEqual(again.claimedNonces, []);
});

test("a returned job is replaced exactly as before (no chain read)", async () => {
  const state = freshState();
  const first = quotedPod(state, { token: 7, nonceSeed: 1, podSeed: 0xa1, block: 200 });
  await ingestRenterPodRecords(state, [first], { readRequestPod: chain().readRequestPod, nowMs: 1 });
  state.jobs[7].returned = true;
  const second = quotedPod(state, { token: 7, nonceSeed: 2, podSeed: 0xa2, block: 300 });
  const rpc = chain();
  const { outcomes } = await ingestRenterPodRecords(state, [second], { readRequestPod: rpc.readRequestPod, nowMs: 2 });
  assert.deepEqual(outcomes.map((o) => o.outcome), ["adopted"]);
  assert.deepEqual(rpc.reads, []);
  assert.deepEqual(state.retiredJobs, {});
});

test("retired job and stale-request guards", () => {
  assert.equal(retiredJobAction({ actualAccID: 5n, podAccID: 5n }), RetiredJobAction.RETURN_FROM_POD);
  assert.equal(retiredJobAction({ actualAccID: 6n, podAccID: 5n }), RetiredJobAction.COMPLETE);
  const job = { pod: addr(0xa1) };
  assert.equal(requestBelongsToOtherPod(job, { stage: 1n, pod: addr(0xa2) }), true);
  assert.equal(requestBelongsToOtherPod(job, { stage: 3n, pod: addr(0xa1).toUpperCase().replace("0X", "0x") }), false);
  assert.equal(requestBelongsToOtherPod(job, { stage: 0n, pod: ZERO }), false, "stage 0 keeps the existing return path");
});

test("worker tick after a same-batch cancel/re-rent keeps processing every token", async () => {
  // End-to-end at tick level: the pre-fix worker threw here and processed no job.
  const state = freshState();
  const a = quotedPod(state, { token: 7, nonceSeed: 1, podSeed: 0xa1, block: 200 });
  const b = quotedPod(state, { token: 7, nonceSeed: 2, podSeed: 0xa2, block: 201 });
  const c = quotedPod(state, { token: 9, nonceSeed: 3, podSeed: 0xb1, block: 202 });
  const rpc = chain({ 7: b.pod, 9: c.pod });
  const processed = [];
  const retiredProcessed = [];
  const result = await runWorkerTick({
    state,
    ingest: async () => {
      await ingestRenterPodRecords(state, [a, b, c], { readRequestPod: rpc.readRequestPod, nowMs: 1 });
      state.lastBlock = 203;
    },
    processJob: async (job) => processed.push(`${job.tokenIndex}:${job.pod}`),
    processRetiredJob: async (job) => {
      retiredProcessed.push(job.pod);
      job.returned = true;
    },
    log: () => {},
  });
  assert.equal(result.ingestOk, true);
  assert.equal(state.lastBlock, 203, "cursor advanced");
  assert.deepEqual(processed.sort(), [`7:${b.pod}`, `9:${c.pod}`].sort());
  assert.deepEqual(retiredProcessed, [a.pod]);
});

test("operator keys differ per pod so a retired job never signs for the live one", async () => {
  const state = freshState();
  const a = quotedPod(state, { token: 7, nonceSeed: 1, podSeed: 0xa1, block: 200 });
  const b = quotedPod(state, { token: 7, nonceSeed: 2, podSeed: 0xa2, block: 201 });
  await ingestRenterPodRecords(state, [a, b], { readRequestPod: chain({ 7: b.pod }).readRequestPod, nowMs: 1 });
  const liveKey = state.jobs[7].operatorKey;
  const retiredKey = state.retiredJobs[retiredJobKey(a)].operatorKey;
  assert.notEqual(liveKey, retiredKey);
  assert.equal(new Wallet(liveKey).address, b.operator);
  assert.equal(new Wallet(retiredKey).address, a.operator);
});
