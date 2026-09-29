import { LeaseAlertCode } from "./renter-pod-alerts.mjs";
import { exitReservePlan } from "./renter-pod-safety.mjs";

export const ActiveAction = Object.freeze({
  END_LEASE: "end-lease",
  ENDING: "ending",
  RECONCILED: "reconciled",
  DEAD: "dead",
  EXIT_STOP_HARVEST: "exit-stop-harvest",
  EXIT_HOLD: "exit-hold",
});

/**
 * One tick of an ACTIVE lease (factory stage 3), with the THR-03 exit reserve
 * checked BEFORE the fail-closed operator gas check. Before this, a strategy
 * that drained escrow made ensureOperatorGas(required:true) throw every tick
 * ahead of endLease and harvest stop, stranding the Kami HARVESTING.
 *
 * Exit reserve mode (balance + escrow below the trigger): stop the Kamibots
 * strategy (not waiting on Kamibots), pull what escrow is left without
 * failing, stop the harvest on-chain while the reserve can still pay for it,
 * alert EXIT_RESERVE_STOP (once on entry) and ESCROW_LOW, and keep the lease
 * moving to its end on the reserve. The strategy restarts only after a
 * renter top-up clears the resume threshold.
 */
export async function advanceActiveLease({
  job,
  nowSec,
  listing,
  market,
  readGas,
  actionGas,
  exitReserveActions,
  resumeHeadroomActions,
  ensureGas,
  strategy,
  readKamiState,
  stopHarvest,
  endLease,
  advanceEnding,
  observeKami,
  alert = () => {},
  log = () => {},
  save = () => {},
  now = () => Date.now(),
}) {
  const { balance, escrow, gasPrice } = await readGas();
  const plan = exitReservePlan({
    balance,
    escrow,
    gasPrice,
    actionGas,
    exitReserveActions,
    resumeHeadroomActions,
    holding: Boolean(job.exitReserve),
  });
  const leaseEnd = Number(listing.leaseEnd);
  const expired = !listing.ending && leaseEnd > 0 && nowSec > leaseEnd;
  const details = {
    token: job.tokenIndex,
    market,
    stage: 3,
    balanceWei: balance,
    escrowWei: escrow,
    availableWei: plan.availableWei,
    reserveWei: plan.reserveWei,
    triggerWei: plan.triggerWei,
  };
  const alertKey = `${job.tokenIndex}:${job.nonce ?? job.pod}`;

  if (plan.mode === "stop" || plan.mode === "hold") {
    if (!job.exitReserve) {
      job.exitReserve = {
        since: now(),
        availableWei: String(plan.availableWei),
        triggerWei: String(plan.triggerWei),
        reserveWei: String(plan.reserveWei),
      };
      log(
        `#${job.tokenIndex}: exit reserve reached (${plan.availableWei} wei left, trigger ${plan.triggerWei}); `
          + "stopping the strategy and the harvest while gas remains"
      );
      alert(LeaseAlertCode.EXIT_RESERVE_STOP, details, { key: `exit:${alertKey}` });
      save();
    }
    alert(LeaseAlertCode.ESCROW_LOW, { ...details, reason: "exit-reserve" }, { key: `escrow:${alertKey}` });

    await strategy.stopForOnChain(job, { force: true });
    try {
      // Pull whatever escrow is left into the operator: in terminal stages the
      // deployed v16 factory cannot pull, so gas must be on the EOA by now.
      await ensureGas({ required: false });
    } catch (error) {
      log(`#${job.tokenIndex}: exit-reserve escrow pull failed (${error?.message ?? error}); trying the stop anyway`);
    }
    if (expired) {
      await endLease();
      return ActiveAction.END_LEASE;
    }
    if (listing.ending) {
      await advanceEnding();
      return ActiveAction.ENDING;
    }
    const kamiState = await readKamiState();
    if (observeKami(kamiState, "exit-reserve")) return ActiveAction.DEAD;
    if (kamiState === "HARVESTING") {
      await stopHarvest();
      return ActiveAction.EXIT_STOP_HARVEST;
    }
    return ActiveAction.EXIT_HOLD;
  }

  if (plan.mode === "resume") {
    log(`#${job.tokenIndex}: escrow topped up to ${plan.availableWei} wei (resume ${plan.resumeWei}); leaving exit reserve`);
    delete job.exitReserve;
    save();
  }

  await ensureGas({ required: true });
  if (expired) {
    await endLease();
    return ActiveAction.END_LEASE;
  }
  if (listing.ending) {
    await advanceEnding();
    return ActiveAction.ENDING;
  }
  const kamiState = await readKamiState();
  if (observeKami(kamiState, "active")) {
    // A DEAD Kami's strategy can only burn operator gas on failing calls, and
    // with reviveOnDeath it could spend pod ONYX. Stop it; a human decides.
    await strategy.stopForOnChain(job, { force: true });
    return ActiveAction.DEAD;
  }
  const remainingSecs = leaseEnd > 0 ? Math.max(0, leaseEnd - nowSec) : 0;
  await strategy.reconcile(job, {
    budget: {
      availableWei: plan.availableWei,
      actionWei: plan.actionWei,
      exitReserveWei: plan.reserveWei,
      remainingSecs,
    },
  });
  return ActiveAction.RECONCILED;
}
