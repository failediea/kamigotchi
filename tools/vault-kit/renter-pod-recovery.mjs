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
