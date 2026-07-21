import test from "node:test";
import assert from "node:assert/strict";
import {
  buildKamibotsStartBody,
  kamibotsStrategySignature,
  normalizeKamibotsPrefs,
} from "./kamibots-rental-config.mjs";

const options = {
  defaultNode: 2,
  botNodes: new Set([2, 34]),
  selfNodes: new Set([47]),
};
const pod = { node: 34, creds: { privyId: "pod-privy-id" } };

test("legacy feed preferences remain compatible", () => {
  const prefs = normalizeKamibotsPrefs(
    { node: 34, risk: "safe", regen: "FEED", food: 11303 },
    options
  );
  assert.equal(prefs.strategy, "harvestAndFeed");
  assert.equal(prefs.food, 11303);
  assert.equal(prefs.hpThresholdLow, 50);
  assert.equal(prefs.hpThresholdHigh, 90);
});

test("harvest and rest sends exact HP thresholds and automatic actions", () => {
  const prefs = normalizeKamibotsPrefs(
    {
      node: 34,
      risk: "custom",
      strategy: "harvestAndRest",
      useHpBasedRest: true,
      hpThresholdLow: 42,
      hpThresholdHigh: 88,
      collectInterval: 2400,
      scavengeInterval: 3600,
    },
    options
  );
  const body = buildKamibotsStartBody(pod, 16218, prefs);
  assert.equal(body.strategyType, "harvestAndRest");
  assert.deepEqual(body.config, {
    targetRoom: 34,
    initialCooldown: 60,
    collectInterval: 2400,
    scavengeInterval: 3600,
    useHpBasedRest: true,
    hpThresholdLow: 42,
    hpThresholdHigh: 88,
  });
});

test("fixed timer rest config uses Kamibots minute limits converted to seconds", () => {
  const prefs = normalizeKamibotsPrefs(
    {
      node: 34,
      strategy: "harvestAndRest",
      useHpBasedRest: false,
      farmInterval: 45 * 60,
      restInterval: 25 * 60,
    },
    options
  );
  const body = buildKamibotsStartBody(pod, 7, prefs);
  assert.equal(body.config.useHpBasedRest, false);
  assert.equal(body.config.farmInterval, 45 * 60);
  assert.equal(body.config.restInterval, 25 * 60);
  assert.equal("hpThresholdLow" in body.config, false);
});

test("timed feed sends food, interval, collect, scavenge, and failsafe", () => {
  const prefs = normalizeKamibotsPrefs(
    {
      node: 34,
      strategy: "harvestAndFeed",
      food: 11314,
      enableFeedInterval: true,
      feedInterval: 90 * 60,
      collectInterval: 60 * 60,
      scavengeInterval: 120 * 60,
      enableFailsafeRest: true,
      failsafeRestDuration: 15 * 60,
    },
    options
  );
  const body = buildKamibotsStartBody(pod, 8, prefs);
  assert.equal(body.strategyType, "harvestAndFeed");
  assert.equal(body.config.foodType, 11314);
  assert.equal(body.config.enableFeedInterval, true);
  assert.equal(body.config.feedInterval, 90 * 60);
  assert.equal(body.config.collectInterval, 60 * 60);
  assert.equal(body.config.scavengeInterval, 120 * 60);
  assert.equal(body.config.failsafeRestDuration, 15 * 60);
});

test("HP-based feed sends feedPercent instead of a feed interval", () => {
  const prefs = normalizeKamibotsPrefs(
    {
      node: 34,
      strategy: "harvestAndFeed",
      food: 11302,
      enableFeedInterval: false,
      feedPercent: 63,
      enableFailsafeRest: false,
    },
    options
  );
  const body = buildKamibotsStartBody(pod, 9, prefs);
  assert.equal(body.config.enableFeedInterval, false);
  assert.equal(body.config.feedPercent, 63);
  assert.equal("feedInterval" in body.config, false);
  assert.equal("failsafeRestDuration" in body.config, false);
});

test("Rest V3 passes only the supported per-Kami controls", () => {
  const prefs = normalizeKamibotsPrefs(
    {
      node: 34,
      strategy: "rest_v3",
      autoCollect: false,
      reviveOnDeath: true,
      safetyMargin: 8,
    },
    options
  );
  const body = buildKamibotsStartBody(pod, 10, prefs);
  assert.equal(body.strategyType, "rest_v3");
  assert.deepEqual(body.config.predatorTeam, {});
  assert.deepEqual(body.config.restV3Preferences, [{
    kamiIndex: 10,
    autoCollect: false,
    reviveOnDeath: true,
    safetyMargin: 8,
  }]);
  assert.equal("bountyCollectThreshold" in body.config.restV3Preferences[0], false);
});

test("signature changes when any renter-visible strategy control changes", () => {
  const base = normalizeKamibotsPrefs({ node: 34 }, options);
  const first = kamibotsStrategySignature(base);
  assert.equal(first.startsWith("34:"), true);
  assert.notEqual(first, kamibotsStrategySignature({ ...base, collectInterval: 3600 }));
  assert.notEqual(first, kamibotsStrategySignature({ ...base, hpThresholdLow: 31 }));
  assert.notEqual(first, kamibotsStrategySignature({ ...base, enableFeedInterval: false }));
});
