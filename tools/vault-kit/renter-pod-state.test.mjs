import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";
import { reservationFileFor } from "./renter-pod-reservations.mjs";
import { loadWorkerState } from "./renter-pod-state.mjs";
import { runWorkerTick } from "./renter-pod-tick.mjs";
import { terminalGasPullMode, terminalGasReturnMode } from "./renter-pod-recovery.mjs";

// Structure copied (read-only, key names and value types only) from the live
// /root/kamigotchi/tools/vault-kit-v16-vipp worker state on 2026-09-29; every
// address, hash, name and number is a dummy.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "test-fixtures", "v16-vipp-live-shape.fixture.json");

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "rp-state-"));
  const stateFile = join(dir, "renter-pod-worker-state.json");
  return { dir, stateFile, reservationFile: reservationFileFor(stateFile) };
}

test("live-shaped v16 VIPP state (lease #5846 history) loads unchanged and round-trips", () => {
  const { dir, stateFile, reservationFile } = scratch();
  try {
    copyFileSync(FIXTURE, stateFile);
    const original = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const before = readFileSync(stateFile, "utf8");
    const loaded = loadWorkerState({ stateFile, reservationFile });

    assert.equal(loaded.migratedReservations, 0);
    assert.equal(loaded.migratedLegacyJobs, 0, "returned #5846 needs no legacy key migration");
    assert.equal(readFileSync(stateFile, "utf8"), before, "loading does not rewrite the state file");
    assert.deepEqual(loaded.state.jobs, original.jobs);
    assert.deepEqual(loaded.state.eventCursor, original.eventCursor);
    assert.equal(loaded.state.lastBlock, original.lastBlock);
    assert.ok(existsSync(reservationFile), "empty reservation store is created");
    assert.equal(statSync(reservationFile).mode & 0o777, 0o600);

    loaded.save();
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), original, "saved shape is identical to the live file");
    assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tick over the live-shaped state skips the returned #5846 job and keeps its history", async () => {
  const { dir, stateFile, reservationFile } = scratch();
  try {
    copyFileSync(FIXTURE, stateFile);
    const { state, save } = loadWorkerState({ stateFile, reservationFile });
    const result = await runWorkerTick({
      state,
      ingest: async () => {},
      processJob: async () => assert.fail("returned jobs are never processed"),
      processRetiredJob: async () => assert.fail("no retired jobs"),
      save,
      log: () => {},
    });
    assert.equal(result.ingestOk, true);
    const onDisk = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(onDisk, JSON.parse(readFileSync(FIXTURE, "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MUSU-shaped state (0 jobs) and a missing state file both load", () => {
  const { dir, stateFile, reservationFile } = scratch();
  try {
    writeFileSync(stateFile, JSON.stringify({ lastBlock: 5, jobs: {}, reservations: {}, eventCursor: { blockNumber: 4, blockHash: `0x${"9".repeat(64)}` } }));
    assert.deepEqual(loadWorkerState({ stateFile, reservationFile }).state.jobs, {});
    rmSync(stateFile);
    rmSync(reservationFile);
    const fresh = loadWorkerState({ stateFile, reservationFile, startBlock: "77" });
    assert.equal(fresh.state.lastBlock, 77);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy state with embedded reservations migrates them to the store (store first)", () => {
  const { dir, stateFile, reservationFile } = scratch();
  try {
    const wallet = Wallet.createRandom();
    const legacy = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const nonce = `0x${"ab".repeat(32)}`;
    legacy.reservations = { [nonce]: { operator: wallet.address, operatorKey: wallet.privateKey, createdAt: 1 } };
    writeFileSync(stateFile, JSON.stringify(legacy, null, 2));

    const loaded = loadWorkerState({ stateFile, reservationFile });
    assert.equal(loaded.migratedReservations, 1);
    assert.equal(loaded.state.reservations[nonce].operator, wallet.address);
    const store = JSON.parse(readFileSync(reservationFile, "utf8"));
    assert.equal(store.reservations[nonce].operatorKey, wallet.privateKey);
    const stateOnDisk = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(stateOnDisk.reservations, {}, "keys no longer rewritten with job state");
    assert.deepEqual(stateOnDisk.jobs, legacy.jobs);

    // Restart after migration keeps the reservation.
    const again = loadWorkerState({ stateFile, reservationFile });
    assert.equal(again.migratedReservations, 0);
    assert.equal(again.state.reservations[nonce].operator, wallet.address);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal gas modes keep the live v16 semantics (return=skip, pull unset = check-only)", () => {
  assert.equal(terminalGasReturnMode("skip"), "skip");
  assert.equal(terminalGasPullMode(undefined), "check-only");
  assert.equal(terminalGasReturnMode(undefined), "factory", "unchanged default for unset return mode");
});
