import assert from "node:assert/strict";
import test from "node:test";
import {
  LEASE_PREFS_FLOOR,
  REST_V3_MEASURED_CYCLE_SEC,
  applyLeasePrefsFloor,
  buildKamibotsStartBody,
  estimateActionsPerDay,
  kamibotsStrategySignature,
  leasePrefsFloorSignature,
  normalizeKamibotsPrefs,
} from "./kamibots-rental-config.mjs";
import { HARDENING_DEFAULTS, hardeningConfigFromEnv, prefsFloorFromEnv } from "./renter-pod-config.mjs";

const options = { defaultNode: 34, botNodes: new Set([34]), selfNodes: new Set() };
const floored = (raw, floor = LEASE_PREFS_FLOOR) =>
  applyLeasePrefsFloor(normalizeKamibotsPrefs(raw, options), floor);
const pod = { node: 34, creds: { privyId: "p" } };

test("floor constants are exported with the H1 values", () => {
  assert.equal(LEASE_PREFS_FLOOR.hpThresholdLowMin, 45);
  assert.equal(LEASE_PREFS_FLOOR.farmIntervalMaxSec, 300 * 60);
  assert.equal(LEASE_PREFS_FLOOR.forceHpBasedRest, true);
  assert.equal(LEASE_PREFS_FLOOR.forceFailsafeRest, true);
  assert.equal(LEASE_PREFS_FLOOR.disallowedRisk, "aggressive");
  assert.equal(LEASE_PREFS_FLOOR.replacementRisk, "balanced");
  assert.ok(Object.isFrozen(LEASE_PREFS_FLOOR));
});

test("the review's deadly prefs are clamped, recorded and still produce a strategy", () => {
  const { prefs, clamped } = floored({
    risk: "aggressive",
    strategy: "harvestAndRest",
    useHpBasedRest: false,
    hpThresholdLow: 5,
    hpThresholdHigh: 8,
    farmInterval: 1200 * 60,
    enableFailsafeRest: false,
  });
  assert.equal(prefs.risk, "balanced");
  assert.equal(prefs.useHpBasedRest, true);
  assert.equal(prefs.hpThresholdLow, 45);
  assert.equal(prefs.hpThresholdHigh, 50);
  assert.equal(prefs.farmInterval, 300 * 60);
  assert.equal(prefs.enableFailsafeRest, true);
  assert.equal(prefs.safetyMargin, 5, "aggressive default margin 2 raised to 5");
  const fields = clamped.map((row) => row.field);
  for (const field of ["risk", "useHpBasedRest", "hpThresholdLow", "hpThresholdHigh", "farmInterval", "enableFailsafeRest", "safetyMargin"]) {
    assert.ok(fields.includes(field), `${field} recorded`);
  }
  assert.deepEqual(clamped.find((row) => row.field === "hpThresholdLow"), { field: "hpThresholdLow", from: 5, to: 45 });
  const body = buildKamibotsStartBody(pod, 7, prefs);
  assert.equal(body.config.useHpBasedRest, true);
  assert.equal(body.config.hpThresholdLow, 45);
  assert.equal("farmInterval" in body.config, false, "HP rest never sends a blind farm timer");
});

test("prefs already inside the floor pass through unchanged", () => {
  const raw = { risk: "safe", strategy: "harvestAndRest", hpThresholdLow: 60, hpThresholdHigh: 95, farmInterval: 3600 };
  const base = normalizeKamibotsPrefs(raw, options);
  const { prefs, clamped } = applyLeasePrefsFloor(base);
  assert.deepEqual(clamped, []);
  assert.equal(kamibotsStrategySignature(prefs), kamibotsStrategySignature(base));
});

test("the balanced default is lifted to the 45% floor", () => {
  const { prefs, clamped } = floored({});
  assert.equal(prefs.hpThresholdLow, 45);
  assert.equal(prefs.hpThresholdHigh, 80);
  assert.deepEqual(clamped, [{ field: "hpThresholdLow", from: 30, to: 45 }]);
});

test("Harvest & Feed keeps failsafe rest, HP-based feeding floor and a capped farm timer", () => {
  const { prefs } = floored({
    strategy: "harvestAndFeed",
    food: 11302,
    enableFeedInterval: false,
    feedPercent: 10,
    enableFailsafeRest: false,
    farmInterval: 900 * 60,
  });
  const body = buildKamibotsStartBody(pod, 8, prefs);
  assert.equal(body.config.enableFailsafeRest, true);
  // Failsafe rest >= max(60 min, rest timer); the rest timer is floored to 51% of 300 min.
  assert.equal(body.config.failsafeRestDuration, Math.ceil(300 * 60 * 0.51));
  assert.equal(body.config.feedPercent, 45);
  assert.equal(body.config.farmInterval, 300 * 60);
});

test("Rest V3 safety margin cannot drop below the balanced preset", () => {
  const { prefs, clamped } = floored({ strategy: "rest_v3", safetyMargin: 0 });
  assert.equal(prefs.safetyMargin, 5);
  assert.ok(clamped.some((row) => row.field === "safetyMargin"));
});

test("a custom floor applies its own limits and changes the floor signature", () => {
  const floor = { ...LEASE_PREFS_FLOOR, hpThresholdLowMin: 60, farmIntervalMaxSec: 3600 };
  const { prefs } = floored({ hpThresholdLow: 50, farmInterval: 7200 }, floor);
  assert.equal(prefs.hpThresholdLow, 60);
  assert.equal(prefs.farmInterval, 3600);
  assert.notEqual(leasePrefsFloorSignature(floor), leasePrefsFloorSignature());
});

test("action-rate estimate mirrors kamistats and counts renter-switchable extras", () => {
  const base = normalizeKamibotsPrefs({ strategy: "harvestAndRest" }, options);
  // 30 + 30 min cycle: 24 cycles * 2 + 4 headroom, exactly estimateRenterGasBudget.
  assert.equal(estimateActionsPerDay(base), 52);
  assert.equal(estimateActionsPerDay({ ...base, collectInterval: 3600 }), 76);
  assert.equal(estimateActionsPerDay({ ...base, collectInterval: 1200, scavengeInterval: 1200 }), 52 + 72 + 72);
  const v3 = normalizeKamibotsPrefs({ strategy: "rest_v3", collectInterval: 1200 }, options);
  assert.equal(estimateActionsPerDay(v3), Math.ceil(86_400 / REST_V3_MEASURED_CYCLE_SEC) * 2 + 4);
  const feed = normalizeKamibotsPrefs({ strategy: "harvestAndFeed", enableFeedInterval: true, feedInterval: 3600 }, options);
  assert.equal(estimateActionsPerDay(feed), 52 + 24);
});

test("hardening config: floor and safety defaults, overrides and strict parsing", () => {
  const config = hardeningConfigFromEnv({});
  assert.equal(config.exitReserveActions, 3);
  assert.equal(config.exitResumeHeadroomActions, HARDENING_DEFAULTS.EXIT_RESUME_HEADROOM_ACTIONS);
  assert.equal(config.cadenceGuard, true);
  assert.equal(config.strategyRestartMinIntervalMs, 3_600_000);
  assert.equal(config.kamibotsStopMaxFailures, 3);
  assert.equal(config.kamibotsRetryMaxMs, 900_000);
  assert.equal(config.prefsFloor.hpThresholdLowMin, 45);
  assert.equal(config.prefsFloor.farmIntervalMaxSec, 18_000);

  const tuned = hardeningConfigFromEnv({
    PREFS_FLOOR_HP_LOW_MIN: "50",
    PREFS_FLOOR_FARM_INTERVAL_MAX_SEC: "7200",
    STRATEGY_RESTART_MIN_INTERVAL_SEC: "0",
    PREFS_CADENCE_GUARD: "off",
    EXIT_RESERVE_ACTIONS: "4",
  });
  assert.equal(tuned.prefsFloor.hpThresholdLowMin, 50);
  assert.equal(tuned.prefsFloor.farmIntervalMaxSec, 7200);
  assert.equal(tuned.strategyRestartMinIntervalMs, 0);
  assert.equal(tuned.cadenceGuard, false);
  assert.equal(tuned.exitReserveActions, 4);

  assert.equal(prefsFloorFromEnv({ PREFS_FLOOR: "off" }), null);
  assert.throws(() => prefsFloorFromEnv({ PREFS_FLOOR: "maybe" }), /PREFS_FLOOR must be on or off/);
  assert.throws(() => prefsFloorFromEnv({ PREFS_FLOOR_HP_LOW_MIN: "95" }), /between 5 and 90/);
  assert.throws(() => prefsFloorFromEnv({ PREFS_FLOOR_FARM_INTERVAL_MAX_SEC: "60" }), /between 1200 and 72000/);
  assert.throws(() => hardeningConfigFromEnv({ KAMIBOTS_STOP_MAX_FAILURES: "0" }), /positive integer/);
});

test("review repro: Harvest & Feed with timer feeding cannot bypass the floor (asserted on the Kamibots body)", async () => {
  const { startBodyFloorViolations } = await import("./kamibots-rental-config.mjs");
  const raw = {
    strategy: "harvestAndFeed",
    enableFeedInterval: true,
    feedInterval: 1200 * 60,
    farmInterval: 1200 * 60,
    restInterval: 15 * 60,
    hpThresholdLow: 5,
  };
  // Without the floor this is exactly the blind 20h-farm / 15-min-rest / 20h-feed body.
  const unfloored = buildKamibotsStartBody(pod, 9, normalizeKamibotsPrefs(raw, options));
  assert.equal(unfloored.config.enableFeedInterval, true);
  assert.ok(startBodyFloorViolations(unfloored).length >= 3, "the checker catches the unfloored body");

  const { prefs, clamped } = floored(raw);
  const body = buildKamibotsStartBody(pod, 9, prefs);
  assert.equal(body.strategyType, "harvestAndFeed");
  assert.equal(body.config.enableFeedInterval, false, "feeds on HP, not on a 20 h timer");
  assert.equal("feedInterval" in body.config, false);
  assert.equal(body.config.feedPercent, 50, "normalize default 50 is above the 45 floor");
  assert.equal(body.config.farmInterval, 300 * 60);
  assert.equal(body.config.restInterval, Math.ceil(300 * 60 * 0.51), "rest >= 51% of farm (measured 147/292)");
  assert.equal(body.config.enableFailsafeRest, true);
  assert.deepEqual(startBodyFloorViolations(body), []);
  const fields = clamped.map((row) => row.field);
  assert.ok(fields.includes("enableFeedInterval") && fields.includes("restInterval") && fields.includes("farmInterval"));
});

test("fuzz: every floored prefs object produces a Kamibots body inside the floor", async () => {
  const { startBodyFloorViolations } = await import("./kamibots-rental-config.mjs");
  let seed = 42;
  const rand = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const pick = (values) => values[Math.floor(rand() * values.length)];
  for (let i = 0; i < 2_000; i++) {
    const raw = {
      strategy: pick(["harvestAndRest", "harvestAndFeed", "rest_v3", "bogus", undefined]),
      risk: pick(["safe", "balanced", "aggressive", "x"]),
      useHpBasedRest: pick([true, false, 1, 0, undefined]),
      hpThresholdLow: pick([0, 5, 20, 44, 45, 80, 90, "x"]),
      hpThresholdHigh: pick([0, 10, 50, 100]),
      farmInterval: pick([0, 1200, 18_000, 18_001, 72_000, 999_999]),
      restInterval: pick([0, 900, 5_000, 9_180, 30_000]),
      enableFeedInterval: pick([true, false, 1, 0, undefined]),
      feedInterval: pick([1_800, 72_000]),
      feedPercent: pick([1, 10, 44, 45, 99]),
      enableFailsafeRest: pick([true, false, undefined]),
      safetyMargin: pick([0, 2, 5, 10]),
    };
    const { prefs } = floored(raw);
    const body = buildKamibotsStartBody(pod, 1, prefs);
    assert.deepEqual(startBodyFloorViolations(body), [], JSON.stringify(raw));
  }
});

test("floor knobs for Harvest & Feed are env-configurable and change the floor signature", () => {
  const floor = prefsFloorFromEnv({ PREFS_FLOOR_REST_PCT_OF_FARM: "80", PREFS_FLOOR_FORCE_HP_FEED: "off" });
  assert.equal(floor.restPctOfFarmMin, 80);
  assert.equal(floor.forceHpFeed, false);
  assert.notEqual(leasePrefsFloorSignature(floor), leasePrefsFloorSignature());
  const { prefs } = floored({ strategy: "harvestAndFeed", enableFeedInterval: true, farmInterval: 6000, restInterval: 900 }, floor);
  assert.equal(prefs.enableFeedInterval, true, "timer feeding allowed when explicitly switched off");
  assert.equal(prefs.restInterval, 4800);
  assert.equal(prefsFloorFromEnv({}).restPctOfFarmMin, 51);
  assert.equal(prefsFloorFromEnv({}).forceHpFeed, true);
  assert.throws(() => prefsFloorFromEnv({ PREFS_FLOOR_REST_PCT_OF_FARM: "0" }), /between 1 and 200/);
});
