// The worker owns the keeper nonce stream: never add a separate same-key timer.
// One bounded accounting transaction per tick, using the durable tx tracker.
export const SETTLEMENT_TX_KEY = 'market:daily-settlement';
export const SETTLEMENT_BATCH_SIZE = 10;
export const SETTLEMENT_MAX_GAS = 6_000_000n;
export const LEGACY_SETTLEMENT_MAX_LISTINGS = 25;
export const STALE_SETTLER_SEC = 3 * 86_400;

export function settlementPlan({ nowSec, lastSettleAt, cooldownSec, inProgress = false, listingCount, isSettler, batchSupported }) {
  if (![nowSec, listingCount, lastSettleAt, cooldownSec].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('invalid settlement state');
  if (listingCount === 0 && !inProgress) return { action: 'idle' };
  if (!inProgress && lastSettleAt > 0 && nowSec < lastSettleAt + cooldownSec) return { action: 'idle' };
  // Deployed markets permit anyone to start after three days of inactivity.
  // initializedAt is internal, so the FIRST cycle still needs an estimateGas
  // from our sender to prove permission. We never infer first-cycle authority
  // from a zero lastSettleAt. Every send below is simulated by the caller.
  if (!inProgress && !isSettler && lastSettleAt > 0 && nowSec < lastSettleAt + STALE_SETTLER_SEC) {
    return { action: 'waiting', reason: 'WAITING_FOR_STALE_SETTLER' };
  }
  if (!batchSupported && listingCount > LEGACY_SETTLEMENT_MAX_LISTINGS) return { action: 'blocked', reason: 'LEGACY_SETTLEMENT_TOO_LARGE' };
  return batchSupported ? { action: 'send', method: 'settleBatch', args: [SETTLEMENT_BATCH_SIZE] } : { action: 'send', method: 'settle', args: [] };
}

export async function advanceDailySettlement({ state, read, pending, send, nowMs = Date.now() }) {
  state.settlement ??= {};
  const status = state.settlement;
  if (nowMs < Number(status.nextCheckAt || 0)) return { action: 'throttled' };
  // Read errors back off too, so an unhealthy RPC cannot become a hot loop.
  status.nextCheckAt = nowMs + 60_000;
  if (await pending()) return { action: 'pending' };
  const plan = settlementPlan(await read());
  status.lastCheckedAt = nowMs;
  status.reason = plan.reason || null;
  if (plan.action === 'blocked') throw new Error(plan.reason);
  if (plan.action === 'send') {
    await send(plan);
    status.lastSubmittedAt = nowMs;
  }
  return plan;
}

export async function executeSettlement({ contract, signer, tracker, plan }) {
  const action = contract.connect(signer).getFunction(plan.method);
  // This is also the exact deployed authorization/cooldown gate, including
  // initializedAt on a market whose first settlement has not happened yet.
  const estimate = await action.estimateGas(...plan.args);
  const gasLimit = estimate * 12n / 10n;
  if (gasLimit > SETTLEMENT_MAX_GAS) throw new Error('SETTLEMENT_GAS_BOUND');
  return tracker.send(SETTLEMENT_TX_KEY, plan.method, {
    signer, request: () => action.populateTransaction(...plan.args, { gasLimit }),
  });
}
