import { EndingAction, endingAction } from "./renter-pod-recovery.mjs";

/** Returned (instead of throwing) when onDead handled a DEAD Kami. */
export const ENDING_DEAD = "dead";

export async function advanceEndingLease({
  tokenIndex,
  stopStrategy,
  readKamiState,
  stopHarvest,
  finalizeLease,
  markFinalized,
  onDead,
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

  // A DEAD Kami can neither stop harvesting nor be finalized/KamiSent. With a
  // handler the job is marked and alerted (DEAD_KAMI) and simply waits for a
  // human-driven revive; without one, keep the historic fail-closed throw.
  if (kamiState === "DEAD" && onDead) {
    await onDead(kamiState);
    return ENDING_DEAD;
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
