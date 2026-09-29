/**
 * Launch-hardening knobs. Every value is env-configurable; the defaults are
 * the soft-launch policy agreed for the v16 markets. Parsing is strict so a
 * typo in an .env fails at startup instead of silently disabling a guard.
 */
import { LEASE_PREFS_FLOOR } from "./kamibots-rental-config.mjs";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export const HARDENING_DEFAULTS = Object.freeze({
  MAX_ACTIVE_LEASES: 20,
  MAX_LIVE_RESERVATIONS: 200,
  MAX_RESERVATIONS_PER_RENTER: 2,
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
});

function boundedInteger(env, name, min, max) {
  const value = positiveIntegerOrZero(env, name);
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max} (got ${value})`);
  }
  return value;
}

function positiveIntegerOrZero(env, name) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return HARDENING_DEFAULTS[name];
  const value = Number(String(raw).trim());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (got ${JSON.stringify(raw)})`);
  }
  return value;
}

/** on/off switch; unset means the safe default. Anything else is a startup error. */
export function parseSwitch(env, name, fallback = true) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(value)) return true;
  if (["off", "false", "0", "no"].includes(value)) return false;
  throw new Error(`${name} must be on or off (got ${JSON.stringify(raw)})`);
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
  });
}

function positiveInteger(env, name) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return HARDENING_DEFAULTS[name];
  const value = Number(String(raw).trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return value;
}

/** Empty or unset means "no allowlist" (null). Otherwise a Set of lowercase
 * addresses; any malformed entry is a startup error, never ignored. */
export function parseRenterAllowlist(raw) {
  const text = String(raw ?? "").trim().replace(/^["']|["']$/g, "");
  if (!text) return null;
  const set = new Set();
  for (const entry of text.split(",")) {
    const address = entry.trim();
    if (!address) continue;
    if (!ADDRESS_RE.test(address)) throw new Error(`RENTER_ALLOWLIST has an invalid address: ${address}`);
    set.add(address.toLowerCase());
  }
  if (!set.size) return null;
  return set;
}

export function hardeningConfigFromEnv(env = process.env) {
  const config = {
    renterAllowlist: parseRenterAllowlist(env.RENTER_ALLOWLIST),
    maxActiveLeases: positiveInteger(env, "MAX_ACTIVE_LEASES"),
    maxLiveReservations: positiveInteger(env, "MAX_LIVE_RESERVATIONS"),
    maxReservationsPerRenter: positiveInteger(env, "MAX_RESERVATIONS_PER_RENTER"),
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
  };
  // The kamistats quote deadline is 15 minutes. A reservation that expires
  // before its quote can still be submitted would orphan the pod's operator.
  if (config.reservationTtlMs < 15 * 60_000) {
    throw new Error("RESERVATION_TTL_SEC must be at least 900 (the quote deadline)");
  }
  if (config.tickWatchdogMs <= config.txWaitTimeoutMs) {
    throw new Error("TICK_WATCHDOG_SEC must exceed TX_WAIT_TIMEOUT_MS so a single tx timeout cannot trip the watchdog");
  }
  return config;
}
