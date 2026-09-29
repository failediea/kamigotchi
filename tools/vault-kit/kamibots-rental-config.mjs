const RISK = {
  safe: { useHpBasedRest: true, hpThresholdLow: 50, hpThresholdHigh: 90 },
  balanced: { useHpBasedRest: true, hpThresholdLow: 30, hpThresholdHigh: 80 },
  aggressive: { useHpBasedRest: true, hpThresholdLow: 15, hpThresholdHigh: 60 },
};

const FOOD_IDS = new Set([11301, 11302, 11303, 11304, 11311, 11312, 11313, 11314]);

const clampInt = (value, min, max, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
};

export function normalizeKamibotsPrefs(input, options) {
  const raw = input && typeof input === "object" ? input : {};
  const botNodes = options.botNodes || new Set();
  const selfNodes = options.selfNodes || new Set();
  let risk = RISK[raw.risk] ? raw.risk : "balanced";
  let node = Number(options.defaultNode);
  let mode = "bot";

  if (raw.mode === "self" && selfNodes.has(Number(raw.node))) {
    mode = "self";
    node = Number(raw.node);
  } else if (botNodes.has(Number(raw.node))) {
    node = Number(raw.node);
  }

  const legacyFeed = raw.regen === "FEED" && FOOD_IDS.has(Number(raw.food));
  const legacyRez = raw.rez === 1 || raw.rez === true;
  const requestedStrategy = String(raw.strategy || "");
  const strategy = legacyRez || requestedStrategy === "rest_v3"
    ? "rest_v3"
    : legacyFeed || requestedStrategy === "harvestAndFeed"
      ? "harvestAndFeed"
      : "harvestAndRest";
  const preset = RISK[risk];
  const foodCandidate = Number(raw.foodType ?? raw.food);
  const food = FOOD_IDS.has(foodCandidate) ? foodCandidate : 11302;
  const useHpBasedRest = raw.useHpBasedRest === undefined
    ? preset.useHpBasedRest
    : raw.useHpBasedRest === true || raw.useHpBasedRest === 1;
  const hpThresholdLow = clampInt(raw.hpThresholdLow, 5, 90, preset.hpThresholdLow);
  const hpThresholdHigh = clampInt(
    raw.hpThresholdHigh,
    hpThresholdLow + 5,
    100,
    Math.max(hpThresholdLow + 5, preset.hpThresholdHigh)
  );

  return {
    risk,
    node,
    mode,
    strategy,
    useHpBasedRest,
    hpThresholdLow,
    hpThresholdHigh,
    farmInterval: clampInt(raw.farmInterval, 20 * 60, 1200 * 60, 30 * 60),
    restInterval: clampInt(raw.restInterval, 15 * 60, 500 * 60, 30 * 60),
    collectInterval: clampInt(raw.collectInterval, 0, 1200 * 60, 0),
    scavengeInterval: clampInt(raw.scavengeInterval, 0, 1200 * 60, 0),
    enableFeedInterval: raw.enableFeedInterval === undefined
      ? true
      : raw.enableFeedInterval === true || raw.enableFeedInterval === 1,
    feedInterval: clampInt(raw.feedInterval, 30 * 60, 1200 * 60, 60 * 60),
    feedPercent: clampInt(raw.feedPercent, 1, 99, 50),
    food,
    enableFailsafeRest: raw.enableFailsafeRest === undefined
      ? true
      : raw.enableFailsafeRest === true || raw.enableFailsafeRest === 1,
    failsafeRestDuration: clampInt(raw.failsafeRestDuration, 60, 1200 * 60, 10 * 60),
    autoCollect: raw.autoCollect === undefined
      ? true
      : raw.autoCollect === true || raw.autoCollect === 1,
    reviveOnDeath: legacyRez || raw.reviveOnDeath === true || raw.reviveOnDeath === 1,
    safetyMargin: clampInt(
      raw.safetyMargin,
      0,
      10,
      risk === "safe" ? 7 : risk === "aggressive" ? 2 : 5
    ),
  };
}

/**
 * Lease strategy safety floor (THR-02). The renter picks the strategy, but the
 * Kami belongs to the pool owner, and a DEAD Kami cannot be KamiSent home.
 * The worker is the only path to Kamibots, so it applies this floor to every
 * normalized prefs object: when the job's strategy first starts, and again on
 * every on-chain prefs update. Out-of-floor values are CLAMPED and recorded on
 * the job; a paid lease is never rejected for its prefs.
 *
 * The web lane mirrors these constants in the quote API and the UI.
 *
 * - useHpBasedRest forced on: Harvest & Rest must rest on HP, never on a blind
 *   timer (1200-minute timers were accepted before).
 * - hpThresholdLowMin 45: rest before HP drops below 45%. The prior range went
 *   down to 5%, where a same-node predator (including the renter's own Kami,
 *   HarvestLiquidateSystem) can liquidate. 45 sits just under the "safe"
 *   preset's 50 and well above "balanced" (30), per the go/no-go H1 fix.
 * - enableFailsafeRest forced on: Harvest & Feed rests if food cannot be used.
 * - risk "aggressive" (the most aggressive preset) maps to "balanced".
 * - safetyMarginMin 5: Rest V3's margin cannot drop below the balanced preset.
 * - feedPercentMin 45: "feed below X% HP" gets the same HP floor.
 * - farmIntervalMaxSec 300 min: the longest fixed farm timer. The only measured
 *   Kamibots cycle (lease #10165, INSECT on a matching tile) farms 292 minutes
 *   before its own optimiser rests (lib/vault-provisioning.ts in kamistats).
 *   A matching tile is the best case, so a fixed timer above ~300 minutes
 *   harvests past the point where Kamibots itself would stop. With HP-based
 *   rest forced on it only binds Harvest & Feed, which farms on a timer.
 */
export const LEASE_PREFS_FLOOR = Object.freeze({
  hpThresholdLowMin: 45,
  farmIntervalMaxSec: 300 * 60,
  safetyMarginMin: 5,
  feedPercentMin: 45,
  forceHpBasedRest: true,
  forceFailsafeRest: true,
  disallowedRisk: "aggressive",
  replacementRisk: "balanced",
});

/** Stable identity of a floor. A strategy started under a different floor is
 * restarted without waiting for the restart debounce. */
export function leasePrefsFloorSignature(floor = LEASE_PREFS_FLOOR) {
  return [
    "floor1",
    floor.hpThresholdLowMin,
    floor.farmIntervalMaxSec,
    floor.safetyMarginMin,
    floor.feedPercentMin,
    floor.forceHpBasedRest ? 1 : 0,
    floor.forceFailsafeRest ? 1 : 0,
    floor.disallowedRisk,
  ].join(":");
}

/**
 * Apply the safety floor to NORMALIZED prefs (normalizeKamibotsPrefs output).
 * Returns the floored copy plus the list of clamps, e.g.
 * [{ field: "hpThresholdLow", from: 5, to: 45 }]. Never throws.
 */
export function applyLeasePrefsFloor(prefs, floor = LEASE_PREFS_FLOOR) {
  const next = { ...prefs };
  const clamped = [];
  const set = (field, value) => {
    if (next[field] === value) return;
    clamped.push({ field, from: next[field], to: value });
    next[field] = value;
  };

  if (floor.disallowedRisk && next.risk === floor.disallowedRisk) {
    set("risk", floor.replacementRisk || "balanced");
  }
  if (floor.forceHpBasedRest) set("useHpBasedRest", true);
  if (Number(next.hpThresholdLow) < floor.hpThresholdLowMin) {
    set("hpThresholdLow", floor.hpThresholdLowMin);
  }
  // Keep the existing invariant high >= low + 5 (capped at 100).
  const minHigh = Math.min(100, Number(next.hpThresholdLow) + 5);
  if (Number(next.hpThresholdHigh) < minHigh) set("hpThresholdHigh", minHigh);
  if (floor.forceFailsafeRest) set("enableFailsafeRest", true);
  if (Number(next.farmInterval) > floor.farmIntervalMaxSec) {
    set("farmInterval", floor.farmIntervalMaxSec);
  }
  if (Number(next.safetyMargin) < floor.safetyMarginMin) {
    set("safetyMargin", floor.safetyMarginMin);
  }
  if (Number(next.feedPercent) < floor.feedPercentMin) {
    set("feedPercent", floor.feedPercentMin);
  }
  return { prefs: next, clamped };
}

/**
 * Operating actions per day a prefs object schedules, for the cadence guard
 * (THR-03). Mirrors kamistats estimateRenterGasBudget (lib/vault-gas-estimate.ts):
 * two actions per farm+rest cycle plus 4 headroom, and additionally counts the
 * collect, scavenge and timed-feed actions a renter can switch on mid-lease.
 * Rest V3 owns its cadence, so it is priced at the measured 292+147-minute
 * Kamibots cycle. Only used to COMPARE two prefs and to size the remaining
 * term; it is deliberately conservative.
 */
export const REST_V3_MEASURED_CYCLE_SEC = (292 + 147) * 60;

export function estimateActionsPerDay(prefs) {
  const day = 86_400;
  const perDay = (seconds) => {
    const value = Number(seconds);
    return Number.isFinite(value) && value > 0 ? Math.ceil(day / Math.max(60, value)) : 0;
  };
  let cycleSec;
  if (prefs.strategy === "rest_v3") {
    cycleSec = REST_V3_MEASURED_CYCLE_SEC;
  } else {
    const farm = Math.max(60, Number(prefs.farmInterval) || 1800);
    const rest = Math.max(60, Number(prefs.restInterval) || 1800);
    cycleSec = farm + rest;
  }
  let actions = Math.ceil(day / cycleSec) * 2 + 4;
  if (prefs.strategy !== "rest_v3") {
    actions += perDay(prefs.collectInterval) + perDay(prefs.scavengeInterval);
  }
  if (prefs.strategy === "harvestAndFeed" && prefs.enableFeedInterval) {
    actions += perDay(prefs.feedInterval);
  }
  return actions;
}

export function kamibotsStrategySignature(prefs) {
  return [
    prefs.node,
    prefs.strategy,
    prefs.risk,
    prefs.useHpBasedRest ? 1 : 0,
    prefs.hpThresholdLow,
    prefs.hpThresholdHigh,
    prefs.farmInterval,
    prefs.restInterval,
    prefs.collectInterval,
    prefs.scavengeInterval,
    prefs.enableFeedInterval ? 1 : 0,
    prefs.feedInterval,
    prefs.feedPercent,
    prefs.food,
    prefs.enableFailsafeRest ? 1 : 0,
    prefs.failsafeRestDuration,
    prefs.autoCollect ? 1 : 0,
    prefs.reviveOnDeath ? 1 : 0,
    prefs.safetyMargin,
  ].join(":");
}

export function buildKamibotsStartBody(pod, tokenIndex, prefs) {
  const keyData = { privy_id: pod.creds.privyId };
  if (prefs.strategy === "rest_v3") {
    return {
      strategyType: "rest_v3",
      kamiId: tokenIndex,
      nodeId: pod.node,
      config: {
        kamiIndices: [tokenIndex],
        nodeId: pod.node,
        // Matches Kamibots' own Command Center client. An empty team tells
        // Rest V3 to use its default apex-predator safety profiles.
        predatorTeam: {},
        restV3Preferences: [{
          kamiIndex: tokenIndex,
          autoCollect: prefs.autoCollect,
          reviveOnDeath: prefs.reviveOnDeath,
          safetyMargin: prefs.safetyMargin,
        }],
      },
      keyData,
    };
  }

  const common = {
    targetRoom: pod.node,
    initialCooldown: 60,
    ...(prefs.collectInterval > 0 ? { collectInterval: prefs.collectInterval } : {}),
    ...(prefs.scavengeInterval > 0 ? { scavengeInterval: prefs.scavengeInterval } : {}),
  };
  if (prefs.strategy === "harvestAndFeed") {
    return {
      strategyType: "harvestAndFeed",
      kamiId: tokenIndex,
      nodeId: pod.node,
      config: {
        ...common,
        useHpBasedRest: false,
        farmInterval: prefs.farmInterval,
        restInterval: prefs.restInterval,
        enableFeedInterval: prefs.enableFeedInterval,
        ...(prefs.enableFeedInterval
          ? { feedInterval: prefs.feedInterval }
          : { feedPercent: prefs.feedPercent }),
        foodType: prefs.food,
        enableFailsafeRest: prefs.enableFailsafeRest,
        ...(prefs.enableFailsafeRest
          ? { failsafeRestDuration: prefs.failsafeRestDuration }
          : {}),
      },
      keyData,
    };
  }

  return {
    strategyType: "harvestAndRest",
    kamiId: tokenIndex,
    nodeId: pod.node,
    config: {
      ...common,
      useHpBasedRest: prefs.useHpBasedRest,
      ...(prefs.useHpBasedRest
        ? {
            hpThresholdLow: prefs.hpThresholdLow,
            hpThresholdHigh: prefs.hpThresholdHigh,
          }
        : {
            farmInterval: prefs.farmInterval,
            restInterval: prefs.restInterval,
          }),
    },
    keyData,
  };
}
