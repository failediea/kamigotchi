/**
 * Process-level smoke test: runs the REAL renter-pod-worker.mjs against an
 * in-process mock JSON-RPC node (no network, no chain, no keys of value) and
 * replays the THR-01 trigger - create, cancel, re-create for one Kami in a
 * single ingest batch, next to an unrelated Kami. The pre-hardening worker
 * threw "received a second active RoomPod event" here on every tick.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AbiCoder, Interface, Wallet, getAddress, id as keccakId, keccak256, toBeHex, zeroPadValue } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const coder = AbiCoder.defaultAbiCoder();
const LATEST = 1_000;

const WORLD = "0x00000000000000000000000000000000000000a1";
const REGISTRY = "0x00000000000000000000000000000000000000a2";
const MARKET = "0x00000000000000000000000000000000000000a3";
const FACTORY = "0x00000000000000000000000000000000000000a4";
const OWNER = "0x00000000000000000000000000000000000000b1";
const RENTER = "0x00000000000000000000000000000000000000c1";
const PODS = {
  A: "0x00000000000000000000000000000000000000d1",
  B: "0x00000000000000000000000000000000000000d2",
  C: "0x00000000000000000000000000000000000000d3",
};
// Deterministic throwaway test keys (hardhat/anvil defaults). Never funded.
const KEEPER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const RES_TOKEN = "smoke-token-".padEnd(40, "x");

const factoryIface = new Interface([
  "function requests(uint32) view returns (address renter,address pod,uint256 gasBudget,uint32 termSecs,uint64 requestedAt,uint8 stage)",
  "function keeper() view returns (address)",
  "event RenterPodCreated(address indexed renter,uint32 indexed tokenIndex,uint32 indexed nodeIndex,address pod,address operator,uint256 setupGasWei,uint256 hubGasWei,uint256 operatingGasWei,bytes32 nonce)",
]);
const marketIface = new Interface([
  "function accID() view returns (uint256)",
  "function listings(uint32) view returns (tuple(address owner,uint256 kamiID,uint256 xpBase,uint16 ownerShareBps,uint128 minGasWei,bool staked,bool returning,bool ending,address renter,uint256 gasBudget,uint32 maxTermSecs,uint64 leaseStart,uint64 leaseEnd,address reservedFor))",
]);
const worldIface = new Interface(["function components() view returns (address)", "function systems() view returns (address)"]);
const registryIface = new Interface(["function getEntitiesWithValue(uint256) view returns (uint256[])"]);
const podIface = new Interface(["function accID() view returns (uint256)"]);
const componentIface = new Interface(["function safeGet(uint256) view returns (uint256)"]);

const blockHash = (n) => keccak256(toBeHex(n, 32));
const componentFor = (value) => getAddress(`0x${BigInt(value).toString(16).padStart(64, "0").slice(-40)}`);

function mockChain({ requestsPod }) {
  const nonces = { A: `0x${"a1".repeat(32)}`, B: `0x${"b2".repeat(32)}`, C: `0x${"c3".repeat(32)}` };
  const operators = { A: Wallet.createRandom(), B: Wallet.createRandom(), C: Wallet.createRandom() };
  const event = factoryIface.getEvent("RenterPodCreated");
  const makeLog = (key, token, block, index) => {
    const { data, topics } = factoryIface.encodeEventLog(event, [
      RENTER,
      token,
      42,
      PODS[key],
      operators[key].address,
      0,
      0,
      0,
      nonces[key],
    ]);
    return {
      address: FACTORY,
      blockHash: blockHash(block),
      blockNumber: toBeHex(block),
      data,
      logIndex: toBeHex(index),
      removed: false,
      topics,
      transactionHash: keccak256(toBeHex(block * 1000 + index, 32)),
      transactionIndex: "0x0",
    };
  };
  // Kami #7: create (pod A) -> cancel -> create (pod B) in one batch; Kami #9 unrelated.
  const logs = [makeLog("A", 7, 500, 0), makeLog("B", 7, 501, 0), makeLog("C", 9, 502, 0)];
  const podAcc = { [PODS.A.toLowerCase()]: 1001n, [PODS.B.toLowerCase()]: 1002n, [PODS.C.toLowerCase()]: 1003n };

  function call({ to, data }) {
    const target = to.toLowerCase();
    const selector = data.slice(0, 10);
    if (target === WORLD) {
      return coder.encode(["address"], [REGISTRY]);
    }
    if (target === REGISTRY) {
      const [value] = registryIface.decodeFunctionData("getEntitiesWithValue", data);
      return coder.encode(["uint256[]"], [[BigInt(componentFor(value))]]);
    }
    if (target === FACTORY) {
      if (selector === factoryIface.getFunction("keeper").selector) {
        return coder.encode(["address"], [new Wallet(KEEPER_KEY).address]);
      }
      const [token] = factoryIface.decodeFunctionData("requests", data);
      const pod = requestsPod[Number(token)] ?? "0x0000000000000000000000000000000000000000";
      return factoryIface.encodeFunctionResult("requests", [RENTER, pod, 0, 0, 0, 0]);
    }
    if (target === MARKET) {
      if (selector === marketIface.getFunction("accID").selector) return coder.encode(["uint256"], [555n]);
      return marketIface.encodeFunctionResult("listings", [
        [OWNER, 77n, 0n, 7000, 0n, false, false, false, "0x0000000000000000000000000000000000000000", 0n, 3600, 0n, 0n, "0x0000000000000000000000000000000000000000"],
      ]);
    }
    if (podAcc[target] !== undefined) return podIface.encodeFunctionResult("accID", [podAcc[target]]);
    // Any registry component: idOwnsKami.safeGet -> Kami is home with its owner.
    if (selector === componentIface.getFunction("safeGet").selector) return coder.encode(["uint256"], [BigInt(OWNER)]);
    throw new Error(`unexpected eth_call to ${to} ${selector}`);
  }

  function block(n) {
    return {
      number: toBeHex(n),
      hash: blockHash(n),
      parentHash: blockHash(n - 1),
      timestamp: toBeHex(1_790_000_000 + n),
      nonce: "0x0000000000000000",
      difficulty: "0x0",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      miner: "0x0000000000000000000000000000000000000000",
      extraData: "0x",
      baseFeePerGas: "0x0",
      transactions: [],
    };
  }

  function handle({ id, method, params }) {
    switch (method) {
      case "eth_chainId":
        return { id, jsonrpc: "2.0", result: "0x1" };
      case "eth_blockNumber":
        return { id, jsonrpc: "2.0", result: toBeHex(LATEST) };
      case "eth_getBlockByNumber":
        return { id, jsonrpc: "2.0", result: block(Number(params[0])) };
      case "eth_getLogs": {
        const from = Number(params[0].fromBlock);
        const to = Number(params[0].toBlock);
        return { id, jsonrpc: "2.0", result: logs.filter((log) => Number(log.blockNumber) >= from && Number(log.blockNumber) <= to) };
      }
      case "eth_call":
        return { id, jsonrpc: "2.0", result: call(params[0]) };
      default:
        return { id, jsonrpc: "2.0", error: { code: -32601, message: `mock: ${method} not supported` } };
    }
  }

  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    let result;
    try {
      result = Array.isArray(payload) ? payload.map(handle) : handle(payload);
    } catch (error) {
      result = { id: payload.id, jsonrpc: "2.0", error: { code: -32000, message: String(error.message) } };
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result));
  });
  return { server, nonces, operators };
}

async function waitFor(predicate, timeoutMs, describe) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${typeof describe === "function" ? describe() : describe}`);
}

test("real worker survives a same-batch cancel/re-rent, keeps other Kamis moving, and writes a heartbeat", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-smoke-"));
  const { server, nonces, operators } = mockChain({ requestsPod: { 7: PODS.B, 9: PODS.C } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const rpc = `http://127.0.0.1:${server.address().port}`;
  const reservationPort = 20_000 + Math.floor(Math.random() * 20_000);
  const stateFile = join(dir, "renter-pod-worker-state.json");
  const reservationFile = join(dir, "renter-pod-worker-state.reservations.json");
  // Legacy-shaped state: reservations embedded in the state file (pre-hardening).
  const reservations = {};
  for (const key of ["A", "B", "C"]) {
    reservations[nonces[key]] = { operator: operators[key].address, operatorKey: operators[key].privateKey, createdAt: Date.now() };
  }
  writeFileSync(stateFile, JSON.stringify({ lastBlock: 400, jobs: {}, reservations }, null, 2));

  let output = "";
  const child = spawn(process.execPath, [join(here, "renter-pod-worker.mjs")], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      YOMINET_RPC: rpc,
      WORLD_ADDR: WORLD,
      MARKET_ADDRESS: MARKET,
      RENTER_POD_FACTORY: FACTORY,
      KEEPER_PRIVATE_KEY: KEEPER_KEY,
      OPERATOR_RESERVATION_TOKEN: RES_TOKEN,
      OPERATOR_RESERVATION_PORT: String(reservationPort),
      WORKER_STATE_FILE: stateFile,
      TERMINAL_GAS_RETURN_MODE: "skip",
      POLL_MS: "1000",
    },
  });
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  try {
    const heartbeatFile = join(dir, "heartbeat.json");
    await waitFor(() => existsSync(heartbeatFile), 30_000, () => `heartbeat.json; worker output:\n${output}`);

    const heartbeat = JSON.parse(readFileSync(heartbeatFile, "utf8"));
    assert.deepEqual(Object.keys(heartbeat), ["ts", "lastBlock", "lastTickOk", "activeJobs", "liveReservations", "tickMs"]);
    assert.equal(heartbeat.lastTickOk, true, output);
    assert.equal(heartbeat.lastBlock, LATEST - 12 + 1);

    // No RENTER_ALLOWLIST in this env: the loud open-rentals banner is printed,
    // and the launch guards line (grepped by the deploy runbook) keeps its
    // prefix and ends with the per-renter lease cap.
    assert.match(output, /WARNING: RENTER_ALLOWLIST is NOT SET - this worker runs OPEN RENTALS\./);
    assert.match(output, /ALLOW_OPEN_RENTALS is not set/);
    assert.match(
      output,
      /launch guards: allowlist=off, maxActiveLeases=20, maxLiveReservations=200, maxReservationsPerRenter=2, .*maxActiveLeasesPerRenter=2\n/
    );

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.doesNotMatch(output, /second active RoomPod event/);
    assert.doesNotMatch(output, /tick failed/);
    assert.equal(state.lastBlock, LATEST - 12 + 1, "cursor advanced past the conflicting batch");
    assert.equal(state.jobs[7].nonce, nonces.B, "Kami #7 tracks the live pod");
    assert.equal(state.jobs[7].returned, true, "stage-0 reconciliation completed it");
    assert.equal(state.jobs[9].returned, true, "unrelated Kami #9 was processed");
    const retired = state.retiredJobs[`7:${nonces.A}`];
    assert.equal(retired.pod.toLowerCase(), PODS.A);
    assert.equal(retired.returned, true, "superseded pod retired through the returned path");
    assert.equal(retired.operatorKey, undefined, "retired job secrets purged");
    assert.deepEqual(state.reservations, {}, "state file no longer carries operator keys");
    assert.equal(state.ingestRetry, undefined, "nothing parked");
    assert.deepEqual(JSON.parse(readFileSync(reservationFile, "utf8")).reservations, {}, "claimed keys released");

    // Reservation server is live (fresh heartbeat) and enforces the renter contract.
    const post = (body) =>
      fetch(`http://127.0.0.1:${reservationPort}/v1/operator-reservations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${RES_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ market: MARKET, factory: FACTORY, ...body }),
      });
    assert.equal((await post({ nonce: `0x${"01".repeat(32)}` })).status, 400);
    const ok = await post({ nonce: `0x${"01".repeat(32)}`, renter: RENTER });
    assert.equal(ok.status, 201);
    assert.equal(
      Object.keys(JSON.parse(readFileSync(reservationFile, "utf8")).reservations).length,
      1,
      "reservation persisted to its own file"
    );

    // HALT file: new leases refused with 503, existing processing unaffected.
    writeFileSync(join(dir, "HALT"), "");
    const halted = await post({ nonce: `0x${"02".repeat(32)}`, renter: RENTER });
    assert.equal(halted.status, 503);
    assert.equal((await halted.json()).reason, "halted");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
