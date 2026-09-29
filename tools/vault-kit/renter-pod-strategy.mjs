import { LeaseAlertCode } from "./renter-pod-alerts.mjs";
import {
  applyLeasePrefsFloor,
  kamibotsStrategySignature,
  leasePrefsFloorSignature,
} from "./kamibots-rental-config.mjs";
import {
  cadenceVerdict,
  kamibotsBackingOff,
  noteKamibotsFailure,
} from "./renter-pod-safety.mjs";

export const StrategyOutcome = Object.freeze({
  UNCHANGED: "unchanged",
  STARTED: "started",
  RESTARTED: "restarted",
  DEBOUNCED: "debounced",
  REFUSED: "refused",
  HELD: "held",
});

export const StopOutcome = Object.freeze({
  NONE: "none",
  STOPPED: "stopped",
  BYPASSED: "bypassed",
});

const NO_FLOOR = "none";

/**
 * Kamibots strategy lifecycle for one worker (THR-02 floor, THR-03 cadence
 * guard, THR-10 debounce/backoff/fallback). Remote calls are injected:
 *   startRemote(job, prefs)  POST /api/strategies/start
 *   stopRemote(job)          DELETE (404 counts as stopped; sets strategyStarted=false)
 *   readRawPrefs(job)        factory.prefs(token) string
 *   normalize(job, raw)      normalizeKamibotsPrefs for the job's node
 */
export function createStrategyController({
  startRemote,
  stopRemote,
  readRawPrefs,
  normalize,
  floor = null,
  restartMinIntervalMs = 3_600_000,
  stopMaxFailures = 3,
  retryMaxMs = 900_000,
  cadenceGuard = true,
  market,
  alert = () => {},
  log = () => {},
  now = () => Date.now(),
  save = () => {},
}) {
  const floorSignature = floor ? leasePrefsFloorSignature(floor) : NO_FLOOR;

  /** Renter prefs -> normalized -> floored. Never throws on bad renter input. */
  async function resolvePrefs(job) {
    const raw = await readRawPrefs(job);
    let parsed = {};
    let invalid = false;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      invalid = true;
    }
    let prefs = normalize(job, parsed);
    let clamped = [];
    if (floor) ({ prefs, clamped } = applyLeasePrefsFloor(prefs, floor));
    if (invalid) clamped = [{ field: "prefs", from: "invalid-json", to: "defaults" }, ...clamped];
    const summary = clamped.map(({ field, from, to }) => `${field} ${from}->${to}`).join(", ");
    const previous = job.prefsClamped?.summary ?? "";
    if (summary !== previous) {
      if (summary) {
        job.prefsClamped = { summary, fields: clamped, at: now() };
        log(`#${job.tokenIndex}: renter prefs clamped by the lease safety floor: ${summary}`);
      } else {
        delete job.prefsClamped;
      }
    }
    return prefs;
  }

  function noteFailure(job, error) {
    job.kamibotsHealth = noteKamibotsFailure(job.kamibotsHealth, error, now(), retryMaxMs);
    save();
  }

  function assertNotBackingOff(job) {
    const health = job.kamibotsHealth;
    if (!kamibotsBackingOff(health, now())) return;
    const retrySec = Math.ceil((Number(health.retryAt) - now()) / 1000);
    if (Number(health.failures) >= stopMaxFailures) {
      alert(
        LeaseAlertCode.STRATEGY_RESTART_STORM,
        {
          token: job.tokenIndex,
          market,
          reason: "kamibots-failing",
          failures: health.failures,
          retrySec,
          err: health.lastError,
        },
        { key: `kb-backoff:${job.tokenIndex}:${job.nonce ?? job.pod}` }
      );
    }
    throw new Error(
      `Kamibots strategy call for Kami #${job.tokenIndex} backing off ${retrySec}s after `
        + `${health.failures} failure(s): ${health.lastError}`
    );
  }

  /**
   * Bring the running strategy in line with the floored renter prefs.
   * budget (ACTIVE only): { availableWei, actionWei, exitReserveWei, remainingSecs }
   */
  async function reconcile(job, { budget = null } = {}) {
    if (job.dead || job.exitReserve) return StrategyOutcome.HELD;
    const prefs = await resolvePrefs(job);
    const desired = kamibotsStrategySignature(prefs);
    if (job.strategyStarted && job.strategySignature === desired) {
      if (job.prefsRefused) delete job.prefsRefused;
      // The running strategy already equals the floored prefs. Adopt it as
      // the baseline (strategies started by a pre-hardening worker have none),
      // so the cadence guard and restart debounce apply from here on.
      if (job.strategyFloor !== floorSignature || !job.appliedPrefs) {
        job.strategyFloor = floorSignature;
        job.appliedPrefs = prefs;
        save();
      }
      return StrategyOutcome.UNCHANGED;
    }

    let target = prefs;
    if (cadenceGuard && budget) {
      const verdict = cadenceVerdict({ prev: job.appliedPrefs ?? null, next: prefs, ...budget });
      if (verdict.flagged) {
        alert(
          LeaseAlertCode.ESCROW_LOW,
          {
            token: job.tokenIndex,
            market,
            stage: 3,
            reason: verdict.allowed ? "cadence-unverified" : "cadence-refused",
            prevActionsPerDay: verdict.prevPerDay,
            nextActionsPerDay: verdict.nextPerDay,
            needWei: verdict.needWei,
            availableWei: budget.availableWei,
          },
          { key: `cadence:${job.tokenIndex}:${job.nonce ?? job.pod}` }
        );
      }
      if (!verdict.allowed) {
        if (job.prefsRefused?.signature !== desired) {
          log(
            `#${job.tokenIndex}: prefs change refused - ${verdict.nextPerDay} actions/day for the remaining term `
              + `needs ${verdict.needWei} wei, only ${budget.availableWei} wei left; keeping the current strategy`
          );
        }
        job.prefsRefused = {
          signature: desired,
          reason: "cadence",
          needWei: String(verdict.needWei),
          availableWei: String(budget.availableWei),
          at: now(),
        };
        if (job.strategyStarted) return StrategyOutcome.REFUSED;
        // Nothing is running (revival, exit-reserve resume, failed restart):
        // run the last accepted prefs, floored again, instead of the refused ones.
        target = floor ? applyLeasePrefsFloor(job.appliedPrefs, floor).prefs : job.appliedPrefs;
      } else if (job.prefsRefused) {
        delete job.prefsRefused;
      }
    }

    const targetSignature = kamibotsStrategySignature(target);
    if (job.strategyStarted && job.strategySignature === targetSignature) return StrategyOutcome.REFUSED;
    assertNotBackingOff(job);

    let outcome = StrategyOutcome.STARTED;
    if (job.strategyStarted) {
      // A strategy started under another (or no) safety floor is replaced at
      // once; only renter-driven changes are debounced.
      const floorChanged = job.strategyFloor !== floorSignature;
      const last = Number(job.lastStrategyRestartAt) || 0;
      if (!floorChanged && last && now() - last < restartMinIntervalMs) {
        const waitSec = Math.ceil((restartMinIntervalMs - (now() - last)) / 1000);
        if (job.pendingStrategySignature !== targetSignature) {
          log(`#${job.tokenIndex}: strategy restart debounced ${waitSec}s (last restart ${new Date(last).toISOString()})`);
        }
        job.pendingStrategySignature = targetSignature;
        alert(
          LeaseAlertCode.STRATEGY_RESTART_STORM,
          {
            token: job.tokenIndex,
            market,
            reason: "debounced",
            restarts: job.strategyRestarts ?? 0,
            nextSec: waitSec,
          },
          { key: `restart:${job.tokenIndex}:${job.nonce ?? job.pod}` }
        );
        return StrategyOutcome.DEBOUNCED;
      }
      try {
        await stopRemote(job);
      } catch (error) {
        noteFailure(job, error);
        throw error;
      }
      job.strategyStarted = false;
      job.lastStrategyRestartAt = now();
      job.strategyRestarts = (Number(job.strategyRestarts) || 0) + 1;
      outcome = StrategyOutcome.RESTARTED;
      save();
    }
    try {
      await startRemote(job, target);
    } catch (error) {
      noteFailure(job, error);
      throw error;
    }
    job.strategyStarted = true;
    job.strategySignature = targetSignature;
    job.strategyFloor = floorSignature;
    job.appliedPrefs = target;
    delete job.kamibotsHealth;
    delete job.pendingStrategySignature;
    save();
    return outcome;
  }

  /**
   * Stop the strategy where the NEXT step is on-chain (ending, exit reserve,
   * KamiSend home). Kamibots failures up to stopMaxFailures in a row rethrow
   * (the tick retries); after that - or at once with force - the caller
   * proceeds on-chain without Kamibots (THR-10). Stop attempts then back off
   * so a hung Kamibots cannot eat the tick budget. The game's harvest cooldown
   * keeps a still-registered strategy from restarting the harvest before the
   * worker finalizes and sends the Kami out of the pod account.
   */
  async function stopForOnChain(job, { force = false } = {}) {
    if (!job.strategyStarted || !job.creds) return StopOutcome.NONE;
    const record = job.kamibotsStop;
    const failures = Number(record?.failures) || 0;
    // Once the job has gone on-chain without Kamibots it stays that way until a
    // stop succeeds: the ending path must not re-block after an exit-reserve
    // (forced) bypass.
    const bypassing = force || failures >= stopMaxFailures || Boolean(record?.bypassedAt);
    if (bypassing && kamibotsBackingOff(record, now())) {
      return StopOutcome.BYPASSED;
    }
    try {
      await stopRemote(job);
      job.strategyStarted = false;
      if (job.kamibotsStop) delete job.kamibotsStop;
      return StopOutcome.STOPPED;
    } catch (error) {
      job.kamibotsStop = noteKamibotsFailure(job.kamibotsStop, error, now(), retryMaxMs);
      if (bypassing || job.kamibotsStop.failures >= stopMaxFailures) {
        if (!job.kamibotsStop.bypassedAt) {
          job.kamibotsStop.bypassedAt = now();
          log(
            `#${job.tokenIndex}: Kamibots stop failed ${job.kamibotsStop.failures}x (${job.kamibotsStop.lastError}); `
              + "continuing with the on-chain stop path without Kamibots"
          );
        }
        save();
        return StopOutcome.BYPASSED;
      }
      save();
      throw error;
    }
  }

  return { resolvePrefs, reconcile, stopForOnChain, floorSignature };
}
