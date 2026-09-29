#!/usr/bin/env node
/**
 * The lease policy the renter-pod worker ENFORCES, exported from one place so
 * the web quote API (kamistats) and the ops scripts can mirror it instead of
 * re-deriving numbers:
 *
 *   - the strategy safety floor, including the farm/rest timer caps and the
 *     Harvest & Feed failsafe rest (THR-02);
 *   - Kamibots' own accepted ranges for every renter-tunable field;
 *   - the action-rate estimate used for gas budgets;
 *   - the billed-gas formula: fee per gas as Yominet bills the worker's txs
 *     (OPERATOR_TX_PRICING=eip1559 default: maxFeePerGas), the 10% unused-gas
 *     charge, and the exit reserve (EXIT_RESERVE_ACTIONS) with its stop and
 *     resume triggers (THR-03);
 *   - the reservation caps, the 429 scopes and the allowlist parsing rules.
 *
 * `node renter-pod-lease-policy.mjs` prints leasePolicySnapshot() as JSON; the committed
 * renter-pod-lease-policy.json is that output (a test fails when they drift). Web and ops
 * copy renter-pod-lease-policy.json and assert their constants against it.
 *
 * Everything here describes the worker's DEFAULTS; an .env override on the
 * box (e.g. OPERATOR_ACTION_GAS_FLOOR) changes the live values.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  KAMIBOTS_PREF_LIMITS,
  LEASE_PREFS_FLOOR,
  REST_V3_MEASURED_CYCLE_SEC,
  applyLeasePrefsFloor,
  estimateActionsPerDay,
  minFailsafeRestSec,
  minRestIntervalSec,
  normalizeKamibotsPrefs,
} from "./kamibots-rental-config.mjs";
import { ALLOWLIST_PARSE_VECTORS, HARDENING_DEFAULTS, OperatorTxPricing } from "./renter-pod-config.mjs";
import { RefusalScope } from "./renter-pod-reservations.mjs";
import { billedActionGas } from "./renter-pod-safety.mjs";

export const LEASE_POLICY_VERSION = 1;

/** Worker defaults for OPERATOR_ACTION_GAS_FLOOR / OPERATOR_RESERVE_GAS_UNITS. */
export const OPERATOR_GAS_DEFAULTS = Object.freeze({
  // Measured operating calls use ~1,611,833 gas; small regression margin.
  actionGasFloor: 1_700_000n,
  // Roughly seven measured actions: the pullGas top-up target (one day).
  reserveGasUnits: 12_000_000n,
});

/** ethers v6 getFeeData() uses this priority fee when the RPC returns none. */
export const ETHERS_DEFAULT_PRIORITY_FEE_WEI = 1_000_000_000n;

/**
 * Fee per gas the worker's own txs are BILLED at, from raw RPC values:
 *   eip1559 (default): max(2 * baseFeePerGas + maxPriorityFeePerGas, gasPrice)
 *     where maxPriorityFeePerGas is eth_maxPriorityFeePerGas, or 1 gwei when
 *     the RPC does not answer it (ethers' default); a chain without a base
 *     fee falls back to gasPrice. Yominet bills maxFeePerGas, not the base
 *     fee. Live 2026-09: baseFee = gasPrice = 2.5 Mwei, priority 0 -> 5 Mwei.
 *   legacy: gasPrice (txs are sent as type 0).
 * Identical to operatorFeePerGas(await provider.getFeeData(), pricing).
 */
export function billedFeePerGas({ gasPrice, baseFeePerGas, maxPriorityFeePerGas, pricing = OperatorTxPricing.EIP1559 }) {
  if (gasPrice == null) throw new Error("gasPrice is required");
  const price = BigInt(gasPrice);
  if (pricing === OperatorTxPricing.LEGACY) return price;
  if (baseFeePerGas == null) return price;
  const priority = maxPriorityFeePerGas == null ? ETHERS_DEFAULT_PRIORITY_FEE_WEI : BigInt(maxPriorityFeePerGas);
  const maxFee = 2n * BigInt(baseFeePerGas) + priority;
  return maxFee > price ? maxFee : price;
}

/** Exit reserve and its triggers, in actions (renter-pod-safety.exitReservePlan). */
export const EXIT_RESERVE = Object.freeze({
  // Kept for stop-harvest, finalize and KamiSend home.
  actions: HARDENING_DEFAULTS.EXIT_RESERVE_ACTIONS,
  // The strategy is stopped once balance + escrow < reserve + 1 action.
  stopTriggerActions: HARDENING_DEFAULTS.EXIT_RESERVE_ACTIONS + 1,
  // ... and restarted only at stop trigger + EXIT_RESUME_HEADROOM_ACTIONS.
  resumeActions: HARDENING_DEFAULTS.EXIT_RESERVE_ACTIONS + 1 + HARDENING_DEFAULTS.EXIT_RESUME_HEADROOM_ACTIONS,
});

/** Wei of one billed operator action at `feePerGas`. */
export function billedActionWei(feePerGas, actionGasFloor = OPERATOR_GAS_DEFAULTS.actionGasFloor) {
  return BigInt(feePerGas) * billedActionGas(actionGasFloor);
}

/** Normalize + floor renter prefs exactly as the worker does before starting Kamibots. */
export function flooredLeasePrefs(rawPrefs, { node, floor = LEASE_PREFS_FLOOR } = {}) {
  const normalized = normalizeKamibotsPrefs(rawPrefs, {
    defaultNode: node,
    botNodes: new Set(node === undefined ? [] : [Number(node)]),
    selfNodes: new Set(),
  });
  return floor ? applyLeasePrefsFloor(normalized, floor).prefs : normalized;
}

/** Operating actions the worker will run over `termSecs` for FLOORED prefs. */
export function leaseOperatingActions(prefs, termSecs) {
  return Math.ceil((estimateActionsPerDay(prefs) * Math.max(0, Number(termSecs) || 0)) / 86_400);
}

/**
 * Operating gas a quote must fund so the lease runs its full term without
 * EXIT_RESERVE_STOP: the term's actions for the FLOORED prefs plus the stop
 * trigger (exit reserve + 1 action), each billed at feePerGas.
 */
export function leaseOperatingGasWei({ prefs, termSecs, feePerGas, actionGasFloor = OPERATOR_GAS_DEFAULTS.actionGasFloor }) {
  const actions = leaseOperatingActions(prefs, termSecs) + EXIT_RESERVE.stopTriggerActions;
  return BigInt(actions) * billedActionWei(feePerGas, actionGasFloor);
}

const str = (value) => (typeof value === "bigint" ? value.toString() : value);

function worked(feeInputs, termSecs, rawPrefs) {
  const fee = billedFeePerGas(feeInputs);
  const prefs = flooredLeasePrefs(rawPrefs, { node: 1 });
  const action = billedActionWei(fee);
  return {
    feeInputs: Object.fromEntries(Object.entries(feeInputs).map(([key, value]) => [key, str(value)])),
    rawPrefs,
    termSecs,
    feePerGasWei: str(fee),
    billedActionWei: str(action),
    exitStopTriggerWei: str(action * BigInt(EXIT_RESERVE.stopTriggerActions)),
    exitResumeWei: str(action * BigInt(EXIT_RESERVE.resumeActions)),
    pullGasTargetWei: str(fee * OPERATOR_GAS_DEFAULTS.reserveGasUnits),
    actionsPerDay: estimateActionsPerDay(prefs),
    operatingActions: leaseOperatingActions(prefs, termSecs),
    operatingGasWei: str(leaseOperatingGasWei({ prefs, termSecs, feePerGas: fee })),
  };
}

/** JSON-safe description of everything above (bigints as decimal strings). */
export function leasePolicySnapshot() {
  const floor = LEASE_PREFS_FLOOR;
  const limits = KAMIBOTS_PREF_LIMITS;
  const live = { gasPrice: 2_500_000n, baseFeePerGas: 2_500_000n, maxPriorityFeePerGas: 0n };
  return {
    version: LEASE_POLICY_VERSION,
    source: "kamigotchi tools/vault-kit/renter-pod-lease-policy.mjs (renter-pod worker)",
    kamibotsPrefLimits: limits,
    prefsFloor: {
      ...floor,
      farmIntervalSec: { min: limits.farmIntervalSec.min, max: floor.farmIntervalMaxSec },
      restIntervalRule:
        "harvestAndFeed (and harvestAndRest with useHpBasedRest=false, which the floor forbids): "
        + `restInterval >= min(${limits.restIntervalSec.max}, ceil(farmInterval * ${floor.restPctOfFarmMin} / 100))`,
      restIntervalSec: { min: limits.restIntervalSec.min, max: limits.restIntervalSec.max },
      restIntervalMinAtMaxFarmSec: minRestIntervalSec(floor.farmIntervalMaxSec, floor),
      failsafeRestRule:
        "harvestAndFeed with failsafe on (forced): failsafeRestDuration >= "
        + `min(${limits.failsafeRestDurationSec.max}, max(${floor.failsafeRestMinSec}, restInterval))`,
      failsafeRestMinAtDefaultsSec: minFailsafeRestSec(limits.restIntervalSec.default, floor),
      hpRule: `useHpBasedRest forced on; hpThresholdLow >= ${floor.hpThresholdLowMin}; hpThresholdHigh >= min(100, hpThresholdLow + 5)`,
      feedRule: `harvestAndFeed feeds on HP (enableFeedInterval=false); feedPercent >= ${floor.feedPercentMin}`,
      riskRule: `risk "${floor.disallowedRisk}" becomes "${floor.replacementRisk}"; safetyMargin >= ${floor.safetyMarginMin}`,
    },
    actionsPerDay: {
      formula:
        "rest_v3: cycle = REST_V3_MEASURED_CYCLE_SEC, else cycle = max(60,farm)+max(60,rest); "
        + "actions = ceil(86400/cycle)*2 + 4; non-rest_v3 adds ceil(86400/collect) + ceil(86400/scavenge) "
        + "for intervals > 0; harvestAndFeed with a feed timer adds ceil(86400/feedInterval). "
        + "Computed on FLOORED prefs.",
      restV3MeasuredCycleSec: REST_V3_MEASURED_CYCLE_SEC,
    },
    gas: {
      defaultPricing: OperatorTxPricing.EIP1559,
      feePerGasFormula: {
        eip1559:
          "max(2 * baseFeePerGas + maxPriorityFeePerGas, gasPrice); maxPriorityFeePerGas = eth_maxPriorityFeePerGas "
          + "or 1 gwei when the RPC returns none; no base fee -> gasPrice",
        legacy: "gasPrice",
      },
      ethersDefaultPriorityFeeWei: str(ETHERS_DEFAULT_PRIORITY_FEE_WEI),
      actionGasFloor: str(OPERATOR_GAS_DEFAULTS.actionGasFloor),
      billedActionGasFormula: "units + floor(units / 10)  (Yominet charges 10% of unused gas)",
      billedActionGas: str(billedActionGas(OPERATOR_GAS_DEFAULTS.actionGasFloor)),
      reserveGasUnits: str(OPERATOR_GAS_DEFAULTS.reserveGasUnits),
      pullGasTargetFormula: "reserveGasUnits * feePerGas",
      exitReserveActions: EXIT_RESERVE.actions,
      exitStopTriggerActions: EXIT_RESERVE.stopTriggerActions,
      exitResumeActions: EXIT_RESERVE.resumeActions,
      exitRule:
        "ACTIVE lease: strategy stopped when operatorBalance + escrow < exitStopTriggerActions * billedActionWei; "
        + "restarted at >= exitResumeActions * billedActionWei",
      operatingBudgetExtraActions: EXIT_RESERVE.stopTriggerActions,
      operatingBudgetFormula:
        "(ceil(actionsPerDay(flooredPrefs) * termSecs / 86400) + operatingBudgetExtraActions) "
        + "* billedActionGas * feePerGas",
      setupAndHubRule: "price setupGasWei and hubGasWei at the same billed feePerGas",
      examples: [
        worked(live, 86_400, {}),
        worked(live, 86_400, { strategy: "harvestAndFeed", farmInterval: 72_000, restInterval: 900 }),
        worked({ ...live, pricing: OperatorTxPricing.LEGACY }, 86_400, {}),
      ],
    },
    reservations: {
      maxActiveLeases: HARDENING_DEFAULTS.MAX_ACTIVE_LEASES,
      maxActiveLeasesPerRenter: HARDENING_DEFAULTS.MAX_ACTIVE_LEASES_PER_RENTER,
      maxLiveReservations: HARDENING_DEFAULTS.MAX_LIVE_RESERVATIONS,
      maxReservationsPerRenter: HARDENING_DEFAULTS.MAX_RESERVATIONS_PER_RENTER,
      maxReservationsPerListing: HARDENING_DEFAULTS.MAX_RESERVATIONS_PER_LISTING,
      reservationTtlSec: HARDENING_DEFAULTS.RESERVATION_TTL_SEC,
      reserveBody: "{ market, factory, nonce, renter, tokenIndex }  (tokenIndex optional but should be sent)",
      attestBody: "{ market, factory, quote }  (quote.renter and quote.tokenIndex required)",
      refusal429Body: "{ error, code: LEASE_CAP | RESERVATION_CAP, scope }",
      refusalScopes: {
        [RefusalScope.RESERVATION]: "RESERVATION_CAP: this wallet has maxReservationsPerRenter open checkouts",
        [RefusalScope.RENTER]: "RESERVATION_CAP: this wallet holds maxActiveLeasesPerRenter leases (active + in checkout)",
        [RefusalScope.LEASE]: "RESERVATION_CAP: this listing has maxReservationsPerListing open checkouts",
        [RefusalScope.MARKET]: "LEASE_CAP: market at maxActiveLeases; RESERVATION_CAP: maxLiveReservations checkouts in flight",
      },
    },
    renterAllowlist: {
      rules: [
        "trim; strip one pair of matching surrounding quotes; trim",
        "empty -> no allowlist",
        "split on ','; trim entries; skip empty entries",
        "each entry: 0x + 40 hex digits, any case (no checksum check), else hard error at startup",
        "non-empty value without any address -> hard error",
        "compare lowercased",
      ],
      vectors: ALLOWLIST_PARSE_VECTORS,
    },
  };
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.stdout.write(`${JSON.stringify(leasePolicySnapshot(), null, 2)}\n`);
