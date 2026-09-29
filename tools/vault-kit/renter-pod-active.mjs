import { LeaseAlertCode } from "./renter-pod-alerts.mjs";
import { exitReservePlan } from "./renter-pod-safety.mjs";
import { StopOutcome } from "./renter-pod-strategy.mjs";

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

    const stop = await strategy.stopForOnChain(job, { force: true });
    // BYPASSED: Kamibots did not confirm the stop, so the strategy may still be
    // running with the operator key. Escrow in the factory is out of its
    // reach; escrow pulled onto the EOA is not. Then pull just in time, one
    // exit tx at a time, instead of handing it the whole remainder.
    const strategyMayRun = stop === StopOutcome.BYPASSED;
    const pull = async (targetActions) => {
      try {
        await ensureGas({ required: false, ...(targetActions ? { targetActions } : {}) });
      } catch (error) {
        log(`#${job.tokenIndex}: exit-reserve escrow pull failed (${error?.message ?? error}); trying the stop anyway`);
      }
    };
    // Stop confirmed: pull whatever escrow is left into the operator now - in
    // terminal stages the deployed v16 factory cannot pull, so gas must be on
    // the EOA before the lease leaves stage 3.
    if (!strategyMayRun) await pull(null);
    if (expired) {
      if (strategyMayRun) await pull(1);
      await endLease();
      return ActiveAction.END_LEASE;
    }
    if (listing.ending) {
      // The ending's next tx (harvest stop or finalizeMarketLease) plus the
      // KamiSend home after finalize, which stage 5 can no longer pull for.
      if (strategyMayRun) await pull(2);
      await advanceEnding();
      return ActiveAction.ENDING;
    }
    const kamiState = await readKamiState();
    if (observeKami(kamiState, "exit-reserve")) return ActiveAction.DEAD;
    if (kamiState === "HARVESTING") {
      if (strategyMayRun) await pull(1);
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
