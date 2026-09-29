/**
 * Launch-hardening knobs. Every value is env-configurable; the defaults are
 * the soft-launch policy agreed for the v16 markets. Parsing is strict so a
 * typo in an .env fails at startup instead of silently disabling a guard.
 */
import { existsSync, readFileSync } from "node:fs";
import { LEASE_PREFS_FLOOR } from "./kamibots-rental-config.mjs";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * A worker configuration error. `key` is the offending env key, so the
 * startup failure names the knob to fix instead of printing a stack trace.
 */
export class ConfigError extends Error {
  constructor(key, message) {
    super(message);
    this.name = "ConfigError";
    this.key = key;
  }
}

/** Remove ONE pair of matching surrounding quotes ("x" or 'x'); else unchanged. */
export function stripMatchingQuotes(value) {
  const text = String(value ?? "");
  if (text.length >= 2) {
    const first = text[0];
    if ((first === '"' || first === "'") && text[text.length - 1] === first) return text.slice(1, -1);
  }
  return text;
}

/**
 * Parse .env text: KEY=value lines (KEY = [A-Za-z_][A-Za-z0-9_]*, optional
 * "export "), blank lines and #-comments ignored. The value is trimmed and one
 * pair of matching surrounding quotes is stripped, so MAX_ACTIVE_LEASES="20"
 * means 20 (the example file quotes every value). Nothing else is unescaped.
 */
export function parseEnvText(text) {
  const values = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    values[match[1]] = stripMatchingQuotes(match[2].trim());
  }
  return values;
}

/**
 * Load a .env file into `env` without overriding keys already set (systemd /
 * shell environment wins). Empty values are not loaded. Returns the keys set.
 */
export function loadEnvFile(path, env = process.env, { read = readFileSync, exists = existsSync } = {}) {
  if (!exists(path)) return [];
  const loaded = [];
  for (const [key, value] of Object.entries(parseEnvText(read(path, "utf8")))) {
    if (value === "" || env[key]) continue;
    env[key] = value;
    loaded.push(key);
  }
  return loaded;
}

export const HARDENING_DEFAULTS = Object.freeze({
  MAX_ACTIVE_LEASES: 20,
  MAX_LIVE_RESERVATIONS: 200,
  MAX_RESERVATIONS_PER_RENTER: 2,
  // Leases one renter may hold at once: unreturned jobs plus live (open or
  // keeper-attested, not yet expired) reservations for that renter.
  MAX_ACTIVE_LEASES_PER_RENTER: 2,
  RESERVATION_TTL_SEC: 1200,
  TX_WAIT_TIMEOUT_MS: 120_000,
  FETCH_TIMEOUT_MS: 20_000,
  TICK_WATCHDOG_SEC: 600,
  HEARTBEAT_STALE_SEC: 180,
  EXIT_RESERVE_ACTIONS: 3,
  ALERT_MIN_INTERVAL_SEC: 300,
  STAGE_STUCK_ALERT_SEC: 1800,
  // Exit reserve (THR-03): a stopped strategy restarts only once operator
  // balance + escrow covers the stop trigger plus this many more actions.
  EXIT_RESUME_HEADROOM_ACTIONS: 2,
  // THR-10: at most one prefs-driven Kamibots restart per lease per window.
  STRATEGY_RESTART_MIN_INTERVAL_SEC: 3600,
  // THR-10: consecutive Kamibots stop failures before the ending / return path
  // proceeds on-chain without Kamibots.
  KAMIBOTS_STOP_MAX_FAILURES: 3,
  // Ceiling of the exponential backoff between failing Kamibots calls per job.
  KAMIBOTS_RETRY_MAX_SEC: 900,
  // THR-02 safety floor (see LEASE_PREFS_FLOOR in kamibots-rental-config.mjs).
  PREFS_FLOOR_HP_LOW_MIN: LEASE_PREFS_FLOOR.hpThresholdLowMin,
  PREFS_FLOOR_FARM_INTERVAL_MAX_SEC: LEASE_PREFS_FLOOR.farmIntervalMaxSec,
  PREFS_FLOOR_SAFETY_MARGIN_MIN: LEASE_PREFS_FLOOR.safetyMarginMin,
  PREFS_FLOOR_FEED_PERCENT_MIN: LEASE_PREFS_FLOOR.feedPercentMin,
  PREFS_FLOOR_REST_PCT_OF_FARM: LEASE_PREFS_FLOOR.restPctOfFarmMin,
  PREFS_FLOOR_FAILSAFE_REST_MIN_SEC: LEASE_PREFS_FLOOR.failsafeRestMinSec,
  // Optional per-listing cap on live reservations, applied when the quote API
  // sends tokenIndex on reserve. 0 = off.
  MAX_RESERVATIONS_PER_LISTING: 0,
  // Event ingest reads at most this many blocks per eth_getLogs call and at
  // most this many calls per tick, so a long outage backlog is caught up in
  // bounded steps instead of one call that times out forever.
  LOG_CHUNK_BLOCKS: 5_000,
  LOG_CHUNKS_PER_TICK: 20,
  // Returned retired (superseded) jobs are dropped from the state file after
  // this many days.
  RETIRED_JOB_RETENTION_DAYS: 30,
});

/**
 * How the worker prices (and, for "legacy", sends) its own txs.
 *   eip1559 (default): txs keep ethers' EIP-1559 fee fields exactly as before;
 *     gas health and the exit reserve are priced at maxFeePerGas, which is
 *     what Yominet bills (never below the node gasPrice).
 *   legacy: txs are sent as type 0 at the node gasPrice, so the cost is exact
 *     and about half of the eip1559 maxFeePerGas default. Switch only after a
 *     smoke-loop receipt confirms effectiveGasPrice on the live chain.
 */
export const OperatorTxPricing = Object.freeze({ EIP1559: "eip1559", LEGACY: "legacy" });

export function operatorTxPricing(raw) {
  const value = stripMatchingQuotes(String(raw ?? "").trim()).trim().toLowerCase() || OperatorTxPricing.EIP1559;
  if (value === OperatorTxPricing.EIP1559 || value === OperatorTxPricing.LEGACY) return value;
  throw new ConfigError("OPERATOR_TX_PRICING", "OPERATOR_TX_PRICING must be eip1559 or legacy");
}

/** Decimal integer text (one pair of surrounding quotes allowed), else NaN.
 * Rejects "", "1e3", "0x10", "12abc" and fractions, which Number() accepts. */
function strictInteger(raw) {
  const text = stripMatchingQuotes(String(raw).trim()).trim();
  return /^-?\d+$/.test(text) ? Number(text) : Number.NaN;
}

function boundedInteger(env, name, min, max) {
  const value = positiveIntegerOrZero(env, name);
  if (value < min || value > max) {
    throw new ConfigError(name, `${name} must be between ${min} and ${max} (got ${value})`);
  }
  return value;
}

function positiveIntegerOrZero(env, name) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return HARDENING_DEFAULTS[name];
  const value = strictInteger(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConfigError(name, `${name} must be a non-negative integer (got ${JSON.stringify(raw)})`);
  }
  return value;
}

/** on/off switch; unset means the safe default. Anything else is a startup error. */
export function parseSwitch(env, name, fallback = true) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = stripMatchingQuotes(String(raw).trim()).trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(value)) return true;
  if (["off", "false", "0", "no"].includes(value)) return false;
  throw new ConfigError(name, `${name} must be on or off (got ${JSON.stringify(raw)})`);
}

/** The THR-02 floor from env, or null when PREFS_FLOOR=off. */
export function prefsFloorFromEnv(env = process.env) {
  if (!parseSwitch(env, "PREFS_FLOOR", true)) return null;
  return Object.freeze({
    ...LEASE_PREFS_FLOOR,
    // Upper bounds keep hpThresholdHigh (>= low + 5, <= 100) satisfiable and the
    // farm timer inside Kamibots' own 20..1200-minute range.
    hpThresholdLowMin: boundedInteger(env, "PREFS_FLOOR_HP_LOW_MIN", 5, 90),
    farmIntervalMaxSec: boundedInteger(env, "PREFS_FLOOR_FARM_INTERVAL_MAX_SEC", 20 * 60, 1200 * 60),
    safetyMarginMin: boundedInteger(env, "PREFS_FLOOR_SAFETY_MARGIN_MIN", 0, 10),
    feedPercentMin: boundedInteger(env, "PREFS_FLOOR_FEED_PERCENT_MIN", 1, 99),
    restPctOfFarmMin: boundedInteger(env, "PREFS_FLOOR_REST_PCT_OF_FARM", 1, 200),
    // Kamibots accepts failsafe rests of 60 s .. 1200 min.
    failsafeRestMinSec: boundedInteger(env, "PREFS_FLOOR_FAILSAFE_REST_MIN_SEC", 60, 1200 * 60),
    forceHpFeed: parseSwitch(env, "PREFS_FLOOR_FORCE_HP_FEED", true),
  });
}

function positiveInteger(env, name) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return HARDENING_DEFAULTS[name];
  const value = strictInteger(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(name, `${name} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return value;
}

/**
 * RENTER_ALLOWLIST parsing. The web lane (LEASE_RENTER_ALLOWLIST) implements
 * the SAME rules and checks them against ALLOWLIST_PARSE_VECTORS (exported in
 * renter-pod-lease-policy.json):
 *   1. trim; strip one pair of matching surrounding quotes; trim again;
 *   2. empty -> null (no allowlist);
 *   3. split on ","; trim each entry; skip empty entries;
 *   4. every entry must be 0x + 40 hex digits in ANY case (no EIP-55 checksum
 *      check: entries are compared lowercased), else a hard startup error;
 *   5. a non-empty value with no address at all (e.g. ",") is an error;
 *   6. result: Set of lowercased addresses.
 */
export function parseRenterAllowlist(raw) {
  const text = stripMatchingQuotes(String(raw ?? "").trim()).trim();
  if (!text) return null;
  const set = new Set();
  for (const entry of text.split(",")) {
    const address = entry.trim();
    if (!address) continue;
    if (!ADDRESS_RE.test(address)) {
      throw new ConfigError("RENTER_ALLOWLIST", `RENTER_ALLOWLIST has an invalid address: ${JSON.stringify(address.slice(0, 64))}`);
    }
    set.add(address.toLowerCase());
  }
  if (!set.size) throw new ConfigError("RENTER_ALLOWLIST", "RENTER_ALLOWLIST is set but lists no address");
  return set;
}

/** Vectors for the allowlist rules above: { input, result } or { input, error }. */
export const ALLOWLIST_PARSE_VECTORS = Object.freeze([
  { input: "", result: null },
  { input: "   ", result: null },
  { input: '""', result: null },
  {
    input: " 0x00000000000000000000000000000000000000Aa , 0x00000000000000000000000000000000000000bB ",
    result: ["0x00000000000000000000000000000000000000aa", "0x00000000000000000000000000000000000000bb"],
  },
  {
    input: '"0x00000000000000000000000000000000000000AA,0x00000000000000000000000000000000000000aa,"',
    result: ["0x00000000000000000000000000000000000000aa"],
  },
  { input: "'0x00000000000000000000000000000000000000c1'", result: ["0x00000000000000000000000000000000000000c1"] },
  { input: "0x52908400098527886E0F7030069857D2E4169EE7", result: ["0x52908400098527886e0f7030069857d2e4169ee7"] },
  { input: "0x52908400098527886e0F7030069857D2E4169EE7", result: ["0x52908400098527886e0f7030069857d2e4169ee7"] },
  { input: ",", error: "RENTER_ALLOWLIST" },
  { input: "0x00000000000000000000000000000000000000c1,nope", error: "RENTER_ALLOWLIST" },
  { input: "0x00000000000000000000000000000000000000c1 0x00000000000000000000000000000000000000c2", error: "RENTER_ALLOWLIST" },
  { input: '"0x00000000000000000000000000000000000000c1', error: "RENTER_ALLOWLIST" },
  { input: "0x00000000000000000000000000000000000000c", error: "RENTER_ALLOWLIST" },
]);

export function hardeningConfigFromEnv(env = process.env) {
  const config = {
    renterAllowlist: parseRenterAllowlist(env.RENTER_ALLOWLIST),
    maxActiveLeases: positiveInteger(env, "MAX_ACTIVE_LEASES"),
    maxLiveReservations: positiveInteger(env, "MAX_LIVE_RESERVATIONS"),
    maxReservationsPerRenter: positiveInteger(env, "MAX_RESERVATIONS_PER_RENTER"),
    maxActiveLeasesPerRenter: positiveInteger(env, "MAX_ACTIVE_LEASES_PER_RENTER"),
    reservationTtlMs: positiveInteger(env, "RESERVATION_TTL_SEC") * 1000,
    txWaitTimeoutMs: positiveInteger(env, "TX_WAIT_TIMEOUT_MS"),
    fetchTimeoutMs: positiveInteger(env, "FETCH_TIMEOUT_MS"),
    tickWatchdogMs: positiveInteger(env, "TICK_WATCHDOG_SEC") * 1000,
    heartbeatStaleMs: positiveInteger(env, "HEARTBEAT_STALE_SEC") * 1000,
    exitReserveActions: positiveInteger(env, "EXIT_RESERVE_ACTIONS"),
    alertMinIntervalMs: positiveInteger(env, "ALERT_MIN_INTERVAL_SEC") * 1000,
    stageStuckAlertMs: positiveInteger(env, "STAGE_STUCK_ALERT_SEC") * 1000,
    exitResumeHeadroomActions: positiveIntegerOrZero(env, "EXIT_RESUME_HEADROOM_ACTIONS"),
    cadenceGuard: parseSwitch(env, "PREFS_CADENCE_GUARD", true),
    strategyRestartMinIntervalMs: positiveIntegerOrZero(env, "STRATEGY_RESTART_MIN_INTERVAL_SEC") * 1000,
    kamibotsStopMaxFailures: positiveInteger(env, "KAMIBOTS_STOP_MAX_FAILURES"),
    kamibotsRetryMaxMs: positiveInteger(env, "KAMIBOTS_RETRY_MAX_SEC") * 1000,
    prefsFloor: prefsFloorFromEnv(env),
    maxReservationsPerListing: positiveIntegerOrZero(env, "MAX_RESERVATIONS_PER_LISTING"),
    logChunkBlocks: boundedInteger(env, "LOG_CHUNK_BLOCKS", 100, 1_000_000),
    logChunksPerTick: boundedInteger(env, "LOG_CHUNKS_PER_TICK", 1, 1_000),
    retiredJobRetentionMs: positiveInteger(env, "RETIRED_JOB_RETENTION_DAYS") * 86_400_000,
    operatorTxPricing: operatorTxPricing(env.OPERATOR_TX_PRICING),
  };
  // The kamistats quote deadline is 15 minutes. A reservation that expires
  // before its quote can still be submitted would orphan the pod's operator.
  if (config.reservationTtlMs < 15 * 60_000) {
    throw new ConfigError("RESERVATION_TTL_SEC", "RESERVATION_TTL_SEC must be at least 900 (the quote deadline)");
  }
  if (config.tickWatchdogMs <= config.txWaitTimeoutMs) {
    throw new ConfigError(
      "TICK_WATCHDOG_SEC",
      "TICK_WATCHDOG_SEC must exceed TX_WAIT_TIMEOUT_MS so a single tx timeout cannot trip the watchdog"
    );
  }
  return config;
}

export const RUNTIME_DEFAULTS = Object.freeze({
  POLL_MS: 30_000,
  EVENT_CONFIRMATIONS: 12,
  OPERATOR_RESERVATION_PORT: 8789,
});

/**
 * The worker's remaining env: required keys and the numeric knobs that used
 * to be parsed inline with Number()/BigInt() (a quoted or malformed value gave
 * a NaN poll interval or a SyntaxError crash loop). Gas defaults come from
 * renter-pod-lease-policy.mjs. Every failure is a ConfigError naming the key.
 */
export function workerRuntimeConfigFromEnv(env = process.env, { actionGasFloorDefault, reserveGasUnitsDefault }) {
  const required = (name) => {
    const value = String(env[name] ?? "").trim();
    if (!value) throw new ConfigError(name, `${name} is required`);
    return value;
  };
  const integer = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === "") return fallback;
    const value = strictInteger(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new ConfigError(name, `${name} must be an integer between ${min} and ${max} (got ${JSON.stringify(raw)})`);
    }
    return value;
  };
  const gasUnits = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === "") return BigInt(fallback);
    const text = stripMatchingQuotes(String(raw).trim()).trim();
    if (!/^\d+$/.test(text) || BigInt(text) <= 0n) {
      throw new ConfigError(name, `${name} must be a positive integer (got ${JSON.stringify(raw)})`);
    }
    return BigInt(text);
  };
  const config = {
    rpc: required("YOMINET_RPC"),
    world: required("WORLD_ADDR"),
    market: required("MARKET_ADDRESS"),
    factory: required("RENTER_POD_FACTORY"),
    keeperKey: required("KEEPER_PRIVATE_KEY"),
    reservationToken: required("OPERATOR_RESERVATION_TOKEN"),
    pollMs: integer("POLL_MS", RUNTIME_DEFAULTS.POLL_MS, 1_000, 3_600_000),
    eventConfirmations: integer("EVENT_CONFIRMATIONS", RUNTIME_DEFAULTS.EVENT_CONFIRMATIONS, 1, 256),
    reservationPort: integer("OPERATOR_RESERVATION_PORT", RUNTIME_DEFAULTS.OPERATOR_RESERVATION_PORT, 1, 65_535),
    startBlock: integer("START_BLOCK", 0, 0, Number.MAX_SAFE_INTEGER),
    operatorActionGasFloor: gasUnits("OPERATOR_ACTION_GAS_FLOOR", actionGasFloorDefault),
    operatorReserveGasUnits: gasUnits("OPERATOR_RESERVE_GAS_UNITS", reserveGasUnitsDefault),
  };
  for (const name of ["WORLD_ADDR", "MARKET_ADDRESS", "RENTER_POD_FACTORY"]) {
    if (!ADDRESS_RE.test(String(env[name]).trim())) {
      throw new ConfigError(name, `${name} must be a 0x-prefixed 20-byte hex address`);
    }
  }
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(config.keeperKey)) {
    // Never echo the value: it is a private key.
    throw new ConfigError("KEEPER_PRIVATE_KEY", "KEEPER_PRIVATE_KEY must be a 32-byte hex private key");
  }
  if (config.reservationToken.length < 32) {
    throw new ConfigError("OPERATOR_RESERVATION_TOKEN", "OPERATOR_RESERVATION_TOKEN must be at least 32 characters");
  }
  if (config.operatorReserveGasUnits < config.operatorActionGasFloor) {
    throw new ConfigError("OPERATOR_RESERVE_GAS_UNITS", "OPERATOR_RESERVE_GAS_UNITS must cover at least one operator action");
  }
  return config;
}
