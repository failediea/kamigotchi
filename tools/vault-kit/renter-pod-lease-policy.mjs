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
 *   - the on-chain lease caps (quotes hold no capacity), the 429 scopes, the
 *     balance filter, the quote deadline bound, the release route, the
 *     operator key custody rules and the allowlist parsing rules.
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
import { ALLOWLIST_PARSE_VECTORS, HARDENING_DEFAULTS, OperatorTxPricing, RETIRED_HARDENING_KNOBS } from "./renter-pod-config.mjs";
import { QUOTE_DEADLINE_SKEW_SEC, RefusalScope } from "./renter-pod-reservations.mjs";
import { billedActionGas } from "./renter-pod-safety.mjs";

// 2: quotes hold no capacity (on-chain-only caps; listing lock, cooldown,
// attempt counter and reservation caps removed; scopes renter + market only;
// bounded quote deadline; durable random per-quote operator keys).
export const LEASE_POLICY_VERSION = 2;

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
      quotesHoldCapacity: false,
      quoteRule:
        "a quote holds NO capacity: no reservation cap, listing lock, cooldown, attempt counter or quote-held lease slot "
        + "exists. Each quote still gets its own random operator key, stored durably before reserve/attest answer; nothing "
        + "counts that store. Contention for one Kami is settled on-chain (factory ActiveRequest / market pending-lease "
        + "revert), so the web must simulate the checkout (eth_call / estimateGas) before asking the wallet to send, and "
        + "show that the Kami was just rented when the simulation reverts",
      maxActiveLeases: HARDENING_DEFAULTS.MAX_ACTIVE_LEASES,
      maxActiveLeasesPerRenter: HARDENING_DEFAULTS.MAX_ACTIVE_LEASES_PER_RENTER,
      capRule:
        "both caps count ON-CHAIN leases only: unreturned ingested pods plus on-chain pods parked for ingest retry, "
        + "distinct per listing. Quotes never count. A listing that already has an on-chain lease never trips a cap. "
        + "Honest concurrent checkouts may overshoot by the quotes issued just under the cap (bounded by listings)",
      reservationTtlSec: HARDENING_DEFAULTS.RESERVATION_TTL_SEC,
      reservationTtlRule:
        "an unattested operator key can be attested for reservationTtlSec; the keeper signs only quote deadlines in the "
        + `future and at most reservationTtlSec + ${QUOTE_DEADLINE_SKEW_SEC} s ahead`,
      reserveBody:
        "{ market, factory, nonce, renter, tokenIndex, fundingWei }  -> 201 { operator }  (nonce 0x + 64 hex; tokenIndex "
        + "optional but should be sent; fundingWei optional decimal string = setupGasWei + hubGasWei + operatingGasWei of "
        + "the priced quote, should be sent)",
      reserveOrder:
        "body checks -> on-chain caps (no RPC) -> balance (only when fundingWei is sent) -> fresh random key -> durable "
        + "(journal append + fsync) -> answer",
      attestBody:
        "{ market, factory, quote }  -> 200 { keeperSignature }  (quote.nonce must name a stored reservation of the same "
        + "renter, quote.operator must be its operator; quote.tokenIndex and quote.deadline required; with "
        + "requireRenterBalance quote.setupGasWei, hubGasWei and operatingGasWei are required; the listing must exist)",
      attestOrder:
        "body checks -> deadline bound -> on-chain caps -> listing exists -> balance -> quoteDigest -> binding durable "
        + "(journal append + fsync) -> keeper signature",
      releasePath: "/v1/operator-reservations/release",
      releaseBody: "{ market, factory, nonce, renter }  -> 200 { released: boolean }; idempotent; answered even while the worker is stale or halted",
      releaseRule:
        "optional hygiene when the renter cancels checkout or the wallet rejects the tx: an unattested key is deleted at "
        + "once; an attested one is only marked (kept until its deadline has passed on-chain). Frees no capacity (none is held)",
      refusal429Body: "{ error, code: LEASE_CAP | RESERVATION_CAP, scope }",
      refusalScopes: {
        [RefusalScope.RENTER]: "RESERVATION_CAP: this wallet holds maxActiveLeasesPerRenter on-chain leases",
        [RefusalScope.MARKET]: "LEASE_CAP: the market holds maxActiveLeases on-chain leases",
      },
      retryAfterRule: "every 503 carries Retry-After: 60; 429s carry none (a cap frees up only when an on-chain lease ends)",
      requireRenterBalance: HARDENING_DEFAULTS.REQUIRE_RENTER_BALANCE,
      renterBalanceRule:
        "attest: renter ETH balance (latest block) >= quote setupGasWei + hubGasWei + operatingGasWei; reserve: >= fundingWei "
        + "when sent, checked before any key is generated. RPC failure fails closed (503 BALANCE_UNAVAILABLE). A filter for "
        + "unfunded requests only: it reserves nothing. An INSUFFICIENT_BALANCE attest deletes the unattested key.",
      insufficientBalanceBody: "403 { error, code: INSUFFICIENT_BALANCE, scope: renter, requiredWei }",
      balanceUnavailableBody: "503 { error, code: BALANCE_UNAVAILABLE }",
      keyStoreUnavailableBody: "503 { error, code: KEY_STORE_UNAVAILABLE }  (the key could not be made durable; nothing was returned)",
      retiredSettings: RETIRED_HARDENING_KNOBS,
    },
    operatorKeys: {
      generation: "one fresh key per quote nonce: 32 bytes from the OS CSPRNG (node:crypto randomBytes); no seed, no derivation",
      durability:
        "reserve: the key is appended to <state>.reservations.journal and fsync'd before the operator address is returned; "
        + "attest: the quote binding (digest, deadline) is appended and fsync'd before the keeper signature is returned",
      store:
        "<state>.reservations.json snapshot { version: 1, generation, reservations } + <state>.reservations.journal (JSON lines); "
        + "both mode 0600; compacted when the journal outgrows the snapshot, at startup and on SIGTERM",
      pruneRule:
        "unattested: after reservationTtlSec; attested: only once ingest has covered a confirmed block whose timestamp is past "
        + "the quote deadline; never while an event for the nonce is parked for ingest retry; never evicted for space",
      ingestRule:
        "on RenterPodCreated the stored key for the event nonce must reproduce the event operator; otherwise the event is "
        + "parked and [LEASE-ALERT] OPERATOR_MISMATCH is raised. A claimed key moves into the job; it is deleted from the "
        + "store only after the job state is saved",
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
