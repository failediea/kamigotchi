import { LeaseAlertCode } from "./renter-pod-alerts.mjs";
import { estimateActionsPerDay } from "./kamibots-rental-config.mjs";

/**
 * Lease safety decisions for the renter-pod worker (THR-02 DEAD handling,
 * THR-03 exit reserve and cadence guard, THR-10 Kamibots backoff). Pure
 * functions over a job record plus injected alert/log sinks, so every branch
 * is unit-tested without a chain.
 *
 * New job fields (all optional; absent on pre-hardening state files, which
 * therefore load and behave unchanged):
 *   job.dead           { since, lastSeenAt, stage, action } while on-chain state is DEAD
 *   job.exitReserve    { since, availableWei, triggerWei, reserveWei } while held
 *   job.kamibotsHealth { failures, retryAt, lastError } for strategy start/restart
 *   job.kamibotsStop   { failures, retryAt, bypassedAt, lastError } for stop calls
 */

export const KAMI_STATE_DEAD = "DEAD";

const text = (error) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/**
 * Record the Kami's on-chain state for a job. DEAD: mark the job and raise
 * "[LEASE-ALERT] DEAD_KAMI token=.. market=.. stage=..", return true so the
 * caller skips any action a DEAD Kami cannot take (KamiSend requires RESTING
 * or LISTED; harvest stop and finalize need a live Kami). The worker never
 * revives or spends ONYX. Anything else clears a previous DEAD mark, so a Kami
 * revived by a human resumes the normal flow on the next tick.
 */
export function observeKamiState(job, kamiState, {
  nowMs = Date.now(),
  stage,
  action,
  market,
  alert = () => {},
  log = () => {},
  alertKey,
} = {}) {
  if (kamiState === KAMI_STATE_DEAD) {
    if (!job.dead) {
      job.dead = { since: nowMs, lastSeenAt: nowMs, stage, action };
      log(
        `#${job.tokenIndex}: Kami is DEAD on-chain at stage ${stage} (${action}); `
          + "holding this job - no KamiSend, no revive, no ONYX spent"
      );
    } else {
      job.dead.lastSeenAt = nowMs;
      job.dead.stage = stage;
      job.dead.action = action;
    }
    alert(
      LeaseAlertCode.DEAD_KAMI,
      {
        token: job.tokenIndex,
        market,
        stage,
        action,
        pod: job.pod,
        sinceSec: Math.floor((nowMs - Number(job.dead.since)) / 1000),
      },
      { key: alertKey ?? `dead:${job.tokenIndex}:${job.nonce ?? job.pod}` }
    );
    return true;
  }
  if (job.dead) {
    log(`#${job.tokenIndex}: Kami is ${kamiState || "unknown"} again (was DEAD since ${new Date(Number(job.dead.since)).toISOString()}); resuming`);
    delete job.dead;
  }
  return false;
}

/**
 * THR-03 exit reserve. The operator EOA is shared with Kamibots, so the
 * strategy can spend the gas the worker needs to stop it. Reserve
 * EXIT_RESERVE_ACTIONS actions (harvest stop, finalize, KamiSend home; each
 * priced at the measured per-action ceiling OPERATOR_ACTION_GAS_FLOOR times
 * the live gas price). The stop fires one action EARLY (trigger = reserve +
 * one action) because a Kamibots action may already be in flight when the
 * worker decides. Once stopped, the strategy restarts only when balance +
 * escrow reach trigger + EXIT_RESUME_HEADROOM_ACTIONS more actions (renter
 * top-up), so it cannot flap around the threshold.
 *
 * mode: "ok" | "stop" (enter) | "hold" (stay stopped) | "resume" (leave).
 */
export function exitReservePlan({
  balance,
  escrow,
  gasPrice,
  actionGas,
  exitReserveActions,
  resumeHeadroomActions = 2,
  holding = false,
}) {
  const actionWei = BigInt(gasPrice) * BigInt(actionGas);
  const reserveWei = actionWei * BigInt(exitReserveActions);
  const triggerWei = reserveWei + actionWei;
  const resumeWei = triggerWei + actionWei * BigInt(resumeHeadroomActions);
  const availableWei = BigInt(balance) + BigInt(escrow);
  let mode;
  if (holding) mode = availableWei >= resumeWei ? "resume" : "hold";
  else mode = availableWei < triggerWei ? "stop" : "ok";
  return { mode, actionWei, reserveWei, triggerWei, resumeWei, availableWei };
}

/**
 * THR-03 cadence guard for a prefs change mid-lease. A change that raises the
 * scheduled action rate is refused when the remaining term at the new rate
 * plus the exit reserve is more than balance + escrow can pay. Changes that
 * keep or lower the rate always pass. Without a known previous prefs object
 * (a strategy started by a pre-hardening worker) the change passes but is
 * flagged when unaffordable.
 */
export function cadenceVerdict({ prev, next, availableWei, actionWei, exitReserveWei, remainingSecs }) {
  const nextPerDay = estimateActionsPerDay(next);
  const prevPerDay = prev ? estimateActionsPerDay(prev) : null;
  const remainingActions = Math.ceil((nextPerDay * Math.max(0, Number(remainingSecs) || 0)) / 86_400);
  const needWei = BigInt(actionWei) * BigInt(remainingActions) + BigInt(exitReserveWei);
  const affordable = needWei <= BigInt(availableWei);
  if (prevPerDay === null) {
    return { allowed: true, raised: null, flagged: !affordable, prevPerDay, nextPerDay, needWei, remainingActions };
  }
  const raised = nextPerDay > prevPerDay;
  return {
    allowed: !raised || affordable,
    raised,
    flagged: raised && !affordable,
    prevPerDay,
    nextPerDay,
    needWei,
    remainingActions,
  };
}

/** Exponential backoff between failing Kamibots calls: 30 s, 60 s, ... capped. */
export function kamibotsBackoffMs(failures, maxMs = 900_000) {
  const step = 30_000 * 2 ** Math.max(0, Math.min(20, failures - 1));
  return Math.min(maxMs, step);
}

export function noteKamibotsFailure(record, error, nowMs, maxMs) {
  const next = record ?? {};
  next.failures = (Number(next.failures) || 0) + 1;
  next.retryAt = nowMs + kamibotsBackoffMs(next.failures, maxMs);
  next.lastError = text(error);
  return next;
}

export function kamibotsBackingOff(record, nowMs) {
  return Boolean(record && Number(record.retryAt) > nowMs);
}
