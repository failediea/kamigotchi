import { EndingAction, endingAction } from "./renter-pod-recovery.mjs";

export async function advanceEndingLease({
  tokenIndex,
  stopStrategy,
  readKamiState,
  stopHarvest,
  finalizeLease,
  markFinalized,
}) {
  await stopStrategy();
  const kamiState = await readKamiState();
  const action = endingAction(kamiState);

  if (action === EndingAction.STOP_HARVEST) {
    await stopHarvest();
    // Never finalize in the same tick. The next tick must prove RESTING from
    // fresh chain state, so a failed or reorged stop cannot be mistaken for
    // successful finalization preparation.
    return EndingAction.STOP_HARVEST;
  }

  if (action !== EndingAction.FINALIZE) {
    throw new Error(
      `lease ending paused for Kami #${tokenIndex}: unexpected on-chain state ${kamiState}`
    );
  }

  await finalizeLease();
  await markFinalized();
  return EndingAction.FINALIZE;
}
