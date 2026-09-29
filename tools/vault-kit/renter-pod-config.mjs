/**
 * Launch-hardening knobs. Every value is env-configurable; the defaults are
 * the soft-launch policy agreed for the v16 markets. Parsing is strict so a
 * typo in an .env fails at startup instead of silently disabling a guard.
 */
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
});

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
