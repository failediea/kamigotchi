/**
 * Process-level: a malformed .env setting makes the REAL worker print one
 * clear CONFIG_ERROR alert naming the key and stay idle, instead of throwing
 * at import time and being restarted by systemd into the same error forever.
 * No chain is needed: configuration is validated before anything connects.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Deterministic throwaway test key (hardhat/anvil default). Never funded.
const KEEPER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const here = dirname(fileURLToPath(import.meta.url));

async function runWorker(extraEnv, { holdMs = 1_500 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rpw-config-"));
  const child = spawn(process.execPath, [join(here, "renter-pod-worker.mjs")], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      // Nothing listens here: if configuration passed, wire() would fail on it.
      YOMINET_RPC: "http://127.0.0.1:9",
      WORLD_ADDR: "0x00000000000000000000000000000000000000a1",
      MARKET_ADDRESS: "0x00000000000000000000000000000000000000a3",
      RENTER_POD_FACTORY: "0x00000000000000000000000000000000000000a4",
      KEEPER_PRIVATE_KEY: KEEPER_KEY,
      OPERATOR_RESERVATION_TOKEN: "config-smoke-".padEnd(40, "x"),
      OPERATOR_RESERVATION_PORT: String(20_000 + Math.floor(Math.random() * 20_000)),
      WORKER_STATE_FILE: join(dir, "state.json"),
      ...extraEnv,
    },
  });
  let output = "";
  let exitCode = null;
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  child.on("exit", (code) => (exitCode = code));
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  const alive = exitCode === null;
  child.kill("SIGTERM");
  await new Promise((resolve) => (exitCode === null ? child.on("exit", resolve) : resolve()));
  const wroteState = existsSync(join(dir, "state.json")) || existsSync(join(dir, "heartbeat.json"));
  rmSync(dir, { recursive: true, force: true });
  return { output, alive, wroteState };
}

test("final-verify repro: a malformed numeric knob holds with a clear CONFIG_ERROR instead of a crash loop", async () => {
  const result = await runWorker({ MAX_ACTIVE_LEASES: "twenty" });
  assert.equal(result.alive, true, `worker must stay up (no restart storm):\n${result.output}`);
  assert.match(result.output, /FATAL configuration error \(MAX_ACTIVE_LEASES\): MAX_ACTIVE_LEASES must be a positive integer/);
  assert.match(result.output, /^\[LEASE-ALERT\] CONFIG_ERROR key=MAX_ACTIVE_LEASES err=/m);
  assert.doesNotMatch(result.output, /\n\s+at /, "no stack trace");
  assert.doesNotMatch(result.output, /renter-funded worker ready/);
  assert.equal(result.wroteState, false, "nothing is written while misconfigured");
});

test("an invalid RENTER_ALLOWLIST entry is a hard startup error (CONFIG_ERROR), never ignored", async () => {
  const result = await runWorker({ RENTER_ALLOWLIST: "0x00000000000000000000000000000000000000c1,0xnot-an-address" });
  assert.equal(result.alive, true);
  assert.match(result.output, /^\[LEASE-ALERT\] CONFIG_ERROR key=RENTER_ALLOWLIST /m);
});

test("a quoted numeric knob is accepted (it reaches the RPC stage, no CONFIG_ERROR)", async () => {
  const result = await runWorker({ MAX_ACTIVE_LEASES: '"20"', POLL_MS: "'1000'" }, { holdMs: 1_000 });
  assert.doesNotMatch(result.output, /CONFIG_ERROR/);
});
