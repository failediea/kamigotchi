import test from 'node:test';
import assert from 'node:assert/strict';
import { settlementPlan, advanceDailySettlement, executeSettlement, SETTLEMENT_TX_KEY, SETTLEMENT_BATCH_SIZE } from './renter-pod-settlement.mjs';
const ready = { nowSec: 100000, lastSettleAt: 1, cooldownSec: 86400, listingCount: 4, isSettler: true, batchSupported: true };

test('daily settlement is due only after cooldown; open batch continues without another day', () => {
  assert.equal(settlementPlan({ ...ready, nowSec: 100 }).action, 'idle');
  assert.deepEqual(settlementPlan(ready), { action: 'send', method: 'settleBatch', args: [SETTLEMENT_BATCH_SIZE] });
  assert.equal(settlementPlan({ ...ready, nowSec: 100, inProgress: true, isSettler: false }).action, 'send');
  assert.equal(settlementPlan({ ...ready, listingCount: 0 }).action, 'idle');
});

test('legacy settlement has a hard listing bound and does not infer settler authority', () => {
  assert.equal(settlementPlan({ ...ready, isSettler: false }).reason, 'WAITING_FOR_STALE_SETTLER');
  assert.equal(settlementPlan({ ...ready, nowSec: 300000, isSettler: false }).action, 'send');
  assert.equal(settlementPlan({ ...ready, lastSettleAt: 0, isSettler: false }).action, 'send'); // simulation must prove initializedAt gate
  assert.equal(settlementPlan({ ...ready, batchSupported: false }).method, 'settle');
  assert.equal(settlementPlan({ ...ready, batchSupported: false, listingCount: 26 }).reason, 'LEGACY_SETTLEMENT_TOO_LARGE');
});

test('pending transaction and failed send cannot duplicate the next tick', async () => {
  const state = {}; let sends = 0; let reads = 0; let isPending = true;
  const deps = { state, read: async () => { reads++; return ready; }, pending: async () => isPending, send: async () => { sends++; throw new Error('timeout'); } };
  assert.equal((await advanceDailySettlement({ ...deps, nowMs: 0 })).action, 'pending');
  assert.equal(reads, 0);
  assert.equal((await advanceDailySettlement({ ...deps, nowMs: 1000 })).action, 'throttled');
  isPending = false;
  await assert.rejects(advanceDailySettlement({ ...deps, nowMs: 60000 }), /timeout/);
  assert.equal(sends, 1);
  assert.equal((await advanceDailySettlement({ ...deps, nowMs: 60001 })).action, 'throttled');
});

test('settlement proves authorization before durable send, uses bounded batch and padded gas', async () => {
  let sent = 0; let simulated = false;
  const plan = settlementPlan(ready);
  const action = { estimateGas: async (n) => { assert.equal(n, 10); simulated = true; return 100000n; }, populateTransaction: (...args) => args };
  const contract = { connect: () => ({ getFunction: (name) => { assert.equal(name, 'settleBatch'); return action; } }) };
  const tracker = { send: async (key, label, request) => { assert.ok(simulated); assert.equal(key, SETTLEMENT_TX_KEY); assert.deepEqual(await request.request(), [10, { gasLimit: 120000n }]); sent++; } };
  await executeSettlement({ contract, tracker, signer: {}, plan });
  assert.equal(sent, 1);
});

test('over-budget or reverted simulation never broadcasts or falls back', async () => {
  let sent = 0;
  const tracker = { send: async () => sent++ };
  for (const estimate of [async () => 6000000n, async () => { throw new Error('NotSettler'); }]) {
    const contract = { connect: () => ({ getFunction: () => ({ estimateGas: estimate }) }) };
    await assert.rejects(executeSettlement({ contract, tracker, signer: {}, plan: settlementPlan(ready) }));
  }
  assert.equal(sent, 0);
});
