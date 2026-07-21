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
