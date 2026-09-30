import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ALLOWLIST_PARSE_VECTORS,
  ConfigError,
  HARDENING_DEFAULTS,
  hardeningConfigFromEnv,
  loadEnvFile,
  parseEnvText,
  parseRenterAllowlist,
  RETIRED_HARDENING_KNOBS,
  retiredKnobsSet,
  stripMatchingQuotes,
  workerRuntimeConfigFromEnv,
} from "./renter-pod-config.mjs";

// Deterministic throwaway test key (hardhat/anvil default). Never funded.
const KEEPER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const GAS_DEFAULTS = { actionGasFloorDefault: 1_700_000n, reserveGasUnitsDefault: 12_000_000n };
const BASE_ENV = Object.freeze({
  YOMINET_RPC: "http://127.0.0.1:1",
  WORLD_ADDR: "0x00000000000000000000000000000000000000a1",
  MARKET_ADDRESS: "0x00000000000000000000000000000000000000a3",
  RENTER_POD_FACTORY: "0x00000000000000000000000000000000000000a4",
  KEEPER_PRIVATE_KEY: KEEPER_KEY,
  OPERATOR_RESERVATION_TOKEN: "t".repeat(40),
});

function configError(fn, key) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error}`);
    assert.equal(error.key, key);
    return error;
  }
  assert.fail(`expected a ConfigError for ${key}`);
}

test(".env values: one pair of MATCHING surrounding quotes is stripped, nothing else", () => {
  const env = parseEnvText([
    "# comment",
    'MAX_ACTIVE_LEASES="20"',
    "MAX_ACTIVE_LEASES_PER_RENTER='3'",
    "POLL_MS=30000\r",
    '  export RENTER_ALLOWLIST = "0x00000000000000000000000000000000000000c1,0x00000000000000000000000000000000000000c2"  ',
    'TOKEN_WITH_QUOTE="abc',
    `MIXED="x'`,
    'INNER=a"b"c',
    "EMPTY=",
    "lowercase_key=1",
    "NOT A LINE",
  ].join("\n"));
  assert.equal(env.MAX_ACTIVE_LEASES, "20");
  assert.equal(env.MAX_ACTIVE_LEASES_PER_RENTER, "3");
  assert.equal(env.POLL_MS, "30000");
  assert.equal(env.RENTER_ALLOWLIST, "0x00000000000000000000000000000000000000c1,0x00000000000000000000000000000000000000c2");
  assert.equal(env.TOKEN_WITH_QUOTE, '"abc', "an unmatched quote is kept (it is part of the value)");
  assert.equal(env.MIXED, `"x'`);
  assert.equal(env.INNER, 'a"b"c');
  assert.equal(env.EMPTY, "");
  assert.equal(env.lowercase_key, "1");
  assert.equal(stripMatchingQuotes('""'), "");
  assert.equal(stripMatchingQuotes('"'), '"');
});

test("final-verify repro: a quoted numeric knob no longer crash-loops the worker", () => {
  const dir = mkdtempSync(join(tmpdir(), "rpw-env-"));
  try {
    const path = join(dir, ".env");
    writeFileSync(path, 'MAX_ACTIVE_LEASES="20"\nOPERATOR_ACTION_GAS_FLOOR="1700000"\nPOLL_MS=\'30000\'\nKEEP=from-file\n');
    const env = { ...BASE_ENV, KEEP: "from-process" };
    const loaded = loadEnvFile(path, env);
    assert.deepEqual(loaded.sort(), ["MAX_ACTIVE_LEASES", "OPERATOR_ACTION_GAS_FLOOR", "POLL_MS"]);
    assert.equal(env.KEEP, "from-process", "process/systemd env wins over the file");
    assert.equal(hardeningConfigFromEnv(env).maxActiveLeases, 20);
    const runtime = workerRuntimeConfigFromEnv(env, GAS_DEFAULTS);
    assert.equal(runtime.pollMs, 30_000);
    assert.equal(runtime.operatorActionGasFloor, 1_700_000n);
    assert.deepEqual(loadEnvFile(join(dir, "missing.env"), {}), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Values that reach the parsers still quoted (e.g. from another loader) work too.
  assert.equal(hardeningConfigFromEnv({ MAX_ACTIVE_LEASES: '"7"', PREFS_FLOOR: "'on'" }).maxActiveLeases, 7);
});

test("a malformed knob is a ConfigError naming the key (clear message, no stack-trace crash)", () => {
  const e = configError(() => hardeningConfigFromEnv({ MAX_ACTIVE_LEASES: "twenty" }), "MAX_ACTIVE_LEASES");
  assert.match(e.message, /MAX_ACTIVE_LEASES must be a positive integer \(got "twenty"\)/);
  configError(() => hardeningConfigFromEnv({ MAX_ACTIVE_LEASES: "1e3" }), "MAX_ACTIVE_LEASES");
  configError(() => hardeningConfigFromEnv({ MAX_ACTIVE_LEASES: "0x10" }), "MAX_ACTIVE_LEASES");
  configError(() => hardeningConfigFromEnv({ MAX_ACTIVE_LEASES_PER_RENTER: "0" }), "MAX_ACTIVE_LEASES_PER_RENTER");
  configError(() => hardeningConfigFromEnv({ EXIT_RESUME_HEADROOM_ACTIONS: "-1" }), "EXIT_RESUME_HEADROOM_ACTIONS");
  configError(() => hardeningConfigFromEnv({ PREFS_CADENCE_GUARD: "sometimes" }), "PREFS_CADENCE_GUARD");
  configError(() => hardeningConfigFromEnv({ OPERATOR_TX_PRICING: "cheap" }), "OPERATOR_TX_PRICING");
  configError(() => hardeningConfigFromEnv({ PREFS_FLOOR_FAILSAFE_REST_MIN_SEC: "30" }), "PREFS_FLOOR_FAILSAFE_REST_MIN_SEC");
  configError(() => hardeningConfigFromEnv({ RENTER_ALLOWLIST: "0xnope" }), "RENTER_ALLOWLIST");

  configError(() => workerRuntimeConfigFromEnv({ ...BASE_ENV, POLL_MS: "abc" }, GAS_DEFAULTS), "POLL_MS");
  configError(() => workerRuntimeConfigFromEnv({ ...BASE_ENV, POLL_MS: "10" }, GAS_DEFAULTS), "POLL_MS");
  configError(() => workerRuntimeConfigFromEnv({ ...BASE_ENV, EVENT_CONFIRMATIONS: "0" }, GAS_DEFAULTS), "EVENT_CONFIRMATIONS");
  configError(() => workerRuntimeConfigFromEnv({ ...BASE_ENV, OPERATOR_RESERVATION_PORT: "80a" }, GAS_DEFAULTS), "OPERATOR_RESERVATION_PORT");
  configError(() => workerRuntimeConfigFromEnv({ ...BASE_ENV, START_BLOCK: "-5" }, GAS_DEFAULTS), "START_BLOCK");
  configError(() => workerRuntimeConfigFromEnv({ ...BASE_ENV, OPERATOR_ACTION_GAS_FLOOR: "1.7e6" }, GAS_DEFAULTS), "OPERATOR_ACTION_GAS_FLOOR");
  configError(
    () => workerRuntimeConfigFromEnv({ ...BASE_ENV, OPERATOR_RESERVE_GAS_UNITS: "1000" }, GAS_DEFAULTS),
    "OPERATOR_RESERVE_GAS_UNITS"
  );
  configError(() => workerRuntimeConfigFromEnv({ ...BASE_ENV, YOMINET_RPC: "" }, GAS_DEFAULTS), "YOMINET_RPC");
  configError(() => workerRuntimeConfigFromEnv({ ...BASE_ENV, MARKET_ADDRESS: "0x12" }, GAS_DEFAULTS), "MARKET_ADDRESS");
  const keyError = configError(
    () => workerRuntimeConfigFromEnv({ ...BASE_ENV, KEEPER_PRIVATE_KEY: '"0xdeadbeef"' }, GAS_DEFAULTS),
    "KEEPER_PRIVATE_KEY"
  );
  assert.doesNotMatch(keyError.message, /deadbeef/, "a private key is never echoed");
  configError(
    () => workerRuntimeConfigFromEnv({ ...BASE_ENV, OPERATOR_RESERVATION_TOKEN: "short" }, GAS_DEFAULTS),
    "OPERATOR_RESERVATION_TOKEN"
  );

  const runtime = workerRuntimeConfigFromEnv(BASE_ENV, GAS_DEFAULTS);
  assert.equal(runtime.pollMs, 30_000);
  assert.equal(runtime.eventConfirmations, 12);
  assert.equal(runtime.reservationPort, 8789);
  assert.equal(runtime.startBlock, 0);
  assert.equal(runtime.operatorReserveGasUnits, 12_000_000n);
});

test("MAX_ACTIVE_LEASES_PER_RENTER defaults to 2 and is configurable", () => {
  assert.equal(HARDENING_DEFAULTS.MAX_ACTIVE_LEASES_PER_RENTER, 2);
  assert.equal(hardeningConfigFromEnv({}).maxActiveLeasesPerRenter, 2);
  assert.equal(hardeningConfigFromEnv({ MAX_ACTIVE_LEASES_PER_RENTER: "1" }).maxActiveLeasesPerRenter, 1);
});

test("allowlist parsing follows the shared vectors exactly (web runs the same vectors)", () => {
  for (const vector of ALLOWLIST_PARSE_VECTORS) {
    if (vector.error) {
      configError(() => parseRenterAllowlist(vector.input), vector.error);
      configError(() => hardeningConfigFromEnv({ RENTER_ALLOWLIST: vector.input }), vector.error);
      continue;
    }
    const parsed = parseRenterAllowlist(vector.input);
    assert.deepEqual(parsed === null ? null : [...parsed], vector.result, JSON.stringify(vector.input));
  }
  // The same value through the .env loader parses identically.
  const fromFile = parseEnvText('RENTER_ALLOWLIST="0x00000000000000000000000000000000000000C1, 0x00000000000000000000000000000000000000c2"');
  assert.deepEqual([...parseRenterAllowlist(fromFile.RENTER_ALLOWLIST)], [
    "0x00000000000000000000000000000000000000c1",
    "0x00000000000000000000000000000000000000c2",
  ]);
});

test("final-verify: every env key the worker reads is documented in renter-pod-worker.env.example", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { dirname: dir } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { RUNTIME_DEFAULTS } = await import("./renter-pod-config.mjs");
  const here = dir(fileURLToPath(import.meta.url));
  const sources = readdirSync(here).filter(
    (name) => (/^renter-pod-.*\.mjs$/.test(name) || name === "kamibots-rental-config.mjs") && !name.endsWith(".test.mjs")
  );
  const keys = new Set([...Object.keys(HARDENING_DEFAULTS), ...Object.keys(RUNTIME_DEFAULTS)]);
  for (const name of sources) {
    const text = readFileSync(join(here, name), "utf8");
    for (const match of text.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]+)/g)) keys.add(match[1]);
    for (const match of text.matchAll(/\b(?:positiveInteger|positiveIntegerOrZero|boundedInteger|parseSwitch|required|integer|gasUnits)\((?:env,\s*)?"([A-Z][A-Z0-9_]+)"/g)) {
      keys.add(match[1]);
    }
  }
  for (const expected of ["EVENT_CONFIRMATIONS", "START_BLOCK", "LEGACY_PROVISIONING_OPERATOR_SEED", "RENTER_ALLOWLIST", "ALLOW_OPEN_RENTALS"]) {
    assert.ok(keys.has(expected), `scanner found ${expected}`);
  }
  const example = readFileSync(join(here, "renter-pod-worker.env.example"), "utf8");
  const missing = [...keys].filter((key) => !new RegExp(`^#?[ \\t]*${key}=`, "m").test(example)).sort();
  assert.deepEqual(missing, [], "undocumented env keys");
  // Stale values the final verification flagged.
  assert.match(example, /^TERMINAL_GAS_RETURN_MODE="skip"$/m);
  assert.doesNotMatch(example, /not authenticated/);
  // Rollback note: wait for pendingTxs to drain before rolling back.
  assert.match(example, /wait until state\.pendingTxs is EMPTY/);
  // Every value in the example parses (quotes included) and every knob it sets is valid.
  const parsed = parseEnvText(example);
  assert.equal(parsed.TERMINAL_GAS_RETURN_MODE, "skip");
  assert.equal(parsed.OPERATOR_ACTION_GAS_FLOOR, "1700000");
  hardeningConfigFromEnv(parsed);
});

test("balance filter defaults ON with strict parsing; quote-capacity knobs are retired, never parsed", () => {
  const config = hardeningConfigFromEnv({});
  assert.equal(config.requireRenterBalance, true);
  assert.equal(config.maxActiveLeasesPerRenter, HARDENING_DEFAULTS.MAX_ACTIVE_LEASES_PER_RENTER, "unchanged");
  assert.equal(hardeningConfigFromEnv({ REQUIRE_RENTER_BALANCE: "off" }).requireRenterBalance, false);
  assert.throws(
    () => hardeningConfigFromEnv({ REQUIRE_RENTER_BALANCE: "maybe" }),
    (error) => error instanceof ConfigError && error.key === "REQUIRE_RENTER_BALANCE"
  );
  // A live .env that still sets the retired knobs (even to junk) starts
  // normally: they are named in the startup log, and nothing reads them.
  const legacyEnv = {
    MAX_LIVE_RESERVATIONS: "200",
    MAX_RESERVATIONS_PER_RENTER: "2",
    MAX_RESERVATIONS_PER_LISTING: "junk",
    LISTING_SINGLE_CHECKOUT: "2",
    LISTING_RESERVE_COOLDOWN_SEC: "-1",
    MAX_RESERVATION_ATTEMPTS_PER_RENTER: "0",
  };
  const retired = hardeningConfigFromEnv(legacyEnv);
  for (const field of ["maxLiveReservations", "maxReservationsPerRenter", "maxReservationsPerListing", "listingSingleCheckout", "listingReserveCooldownMs", "maxReservationAttemptsPerRenter"]) {
    assert.equal(retired[field], undefined, field);
  }
  assert.deepEqual(retiredKnobsSet(legacyEnv), [...RETIRED_HARDENING_KNOBS]);
  assert.deepEqual(retiredKnobsSet({ MAX_LIVE_RESERVATIONS: " " }), [], "an empty value is not 'set'");
  for (const knob of RETIRED_HARDENING_KNOBS) assert.equal(HARDENING_DEFAULTS[knob], undefined, knob);
});
