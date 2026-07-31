export const PreparingAction = Object.freeze({
  WAIT_FOR_FARMING: "wait-for-farming",
  ACTIVATE: "activate",
});

/**
 * Advance a prepared rental without charging the renter for setup or the
 * game's post-send cooldown. Kamibots accepting a strategy means only that
 * automation is armed; it is not proof that the first harvest transaction
 * landed. The paid market clock may start only after fresh chain state says
 * the Kami is HARVESTING.
 */
export async function advancePreparingLease({
  reconcileStrategy,
  readKamiState,
  activateLease,
}) {
  await reconcileStrategy();
  const kamiState = await readKamiState();
  if (kamiState !== "HARVESTING") return PreparingAction.WAIT_FOR_FARMING;

  await activateLease();
  return PreparingAction.ACTIVATE;
}
