import assert from "node:assert/strict";
import test from "node:test";
import { LeaseAlertCode, createLeaseAlerter, formatLeaseAlert } from "./renter-pod-alerts.mjs";
import { HARDENING_DEFAULTS, hardeningConfigFromEnv, parseRenterAllowlist } from "./renter-pod-config.mjs";

test("alert lines use the shared prefix, code and key=value details", () => {
  assert.equal(
    formatLeaseAlert(LeaseAlertCode.INGEST_ERROR, { token: 7, err: "rpc down\nsecond line", big: 10n }),
    "[LEASE-ALERT] INGEST_ERROR token=7 err=rpc_down_second_line big=10"
  );
  assert.throws(() => formatLeaseAlert("MADE_UP", {}), /unknown lease alert code/);
});

test("the closed code set matches the interface contract", () => {
  assert.deepEqual(Object.values(LeaseAlertCode).sort(), [
    "CONFIG_ERROR",
    "DEAD_KAMI",
    "ESCROW_LOW",
    "EXIT_RESERVE_STOP",
    "INGEST_ERROR",
    "LEASE_CAP",
    "RESERVATION_CAP",
    "STAGE_STUCK",
    "STRATEGY_RESTART_STORM",
    "TX_TIMEOUT",
    "WORKER_STALL",
  ]);
});

test("alerter rate-limits per code+key and reports suppressed repeats", () => {
  let clock = 0;
  const lines = [];
  const alert = createLeaseAlerter({ log: (line) => lines.push(line), now: () => clock, minIntervalMs: 1_000 });
  assert.equal(alert("TX_TIMEOUT", { job: "a" }, { key: "a" }), true);
  assert.equal(alert("TX_TIMEOUT", { job: "a" }, { key: "a" }), false);
  assert.equal(alert("TX_TIMEOUT", { job: "b" }, { key: "b" }), true, "different key is independent");
  clock = 1_000;
  assert.equal(alert("TX_TIMEOUT", { job: "a" }, { key: "a" }), true);
  assert.deepEqual(lines, [
    "[LEASE-ALERT] TX_TIMEOUT job=a",
    "[LEASE-ALERT] TX_TIMEOUT job=b",
    "[LEASE-ALERT] TX_TIMEOUT job=a suppressed=1",
  ]);
});

test("hardening defaults match the shared contract", () => {
  const config = hardeningConfigFromEnv({});
  assert.equal(config.renterAllowlist, null);
  assert.equal(config.maxActiveLeases, 20);
  assert.equal(config.maxLiveReservations, 200);
  assert.equal(config.maxReservationsPerRenter, 2);
  assert.equal(config.reservationTtlMs, 1_200_000);
  assert.equal(config.txWaitTimeoutMs, 120_000);
  assert.equal(config.fetchTimeoutMs, 20_000);
  assert.equal(config.tickWatchdogMs, 600_000);
  assert.equal(config.heartbeatStaleMs, 180_000);
  assert.equal(config.exitReserveActions, 3);
  assert.equal(HARDENING_DEFAULTS.EXIT_RESERVE_ACTIONS, 3);
});

test("config parsing is strict", () => {
  assert.equal(parseRenterAllowlist(""), null);
  assert.throws(() => parseRenterAllowlist(" , "), /lists no address/);
  const set = parseRenterAllowlist("0x00000000000000000000000000000000000000AA,0x00000000000000000000000000000000000000bb");
  assert.deepEqual([...set], ["0x00000000000000000000000000000000000000aa", "0x00000000000000000000000000000000000000bb"]);
  assert.throws(() => parseRenterAllowlist("0x123"), /invalid address/);
  assert.throws(() => hardeningConfigFromEnv({ MAX_ACTIVE_LEASES: "0" }), /positive integer/);
  assert.throws(() => hardeningConfigFromEnv({ MAX_ACTIVE_LEASES: "2.5" }), /positive integer/);
  assert.throws(() => hardeningConfigFromEnv({ RESERVATION_TTL_SEC: "600" }), /quote deadline/);
  assert.throws(() => hardeningConfigFromEnv({ TICK_WATCHDOG_SEC: "60", TX_WAIT_TIMEOUT_MS: "120000" }), /must exceed/);
});

test("alerter buckets keyed by request-supplied renters stay bounded", () => {
  let clock = 0;
  const lines = [];
  const alert = createLeaseAlerter({ log: (line) => lines.push(line), now: () => clock, minIntervalMs: 60_000, maxBuckets: 10 });
  for (let i = 0; i < 1_000; i++) {
    clock += 1_000;
    alert("RESERVATION_CAP", { scope: "renter" }, { key: `renter:0x${i}` });
  }
  assert.ok(alert.bucketCount() <= 70, `buckets bounded (got ${alert.bucketCount()})`);
  assert.equal(lines.length, 1_000, "distinct keys are still each reported");
  // A live bucket inside its interval is never evicted: its repeat stays suppressed.
  alert("TX_TIMEOUT", { job: "a" }, { key: "a" });
  for (let i = 0; i < 20; i++) alert("RESERVATION_CAP", {}, { key: `renter:x${i}` });
  assert.equal(alert("TX_TIMEOUT", { job: "a" }, { key: "a" }), false);
});
