export const StageZeroAction = Object.freeze({
  RETURN_FROM_POD: "return-from-pod",
  CLEAR_OWNER_RETURN: "clear-owner-return",
  CONFIRM_POOL_RETURN: "confirm-pool-return",
  COMPLETE: "complete",
  WAIT: "wait",
});

/**
 * Rebuild the post-lease action from durable chain state. Local worker flags
 * are only a cache and must never decide whether a Kami still needs returning.
 */
export function stageZeroAction({ actualAccID, podAccID, ownerAccID, staked, returning }) {
  if (actualAccID === podAccID) return StageZeroAction.RETURN_FROM_POD;
  if (actualAccID !== ownerAccID) return StageZeroAction.WAIT;
  if (returning) return StageZeroAction.CLEAR_OWNER_RETURN;
  if (staked) return StageZeroAction.CONFIRM_POOL_RETURN;
  return StageZeroAction.COMPLETE;
}

export function operatorGasTopUpAmount(balance, budget, reserve) {
  if (balance >= reserve || budget === 0n) return 0n;
  const deficit = reserve - balance;
  return budget < deficit ? budget : deficit;
}

export function operatorGasReturnAmount(balance, gasLimit, gasPrice) {
  const transactionCost = gasLimit * gasPrice;
  return balance > transactionCost ? balance - transactionCost : 0n;
}
