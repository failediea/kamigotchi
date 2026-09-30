/**
 * Process-level safety smoke test: runs the REAL renter-pod-worker.mjs against
 * an in-process mock JSON-RPC node and a mock Kamibots API (no network, no
 * chain, throwaway keys). Three pre-existing jobs:
 *   #11 stage 5 (refund), Kami DEAD inside its pod  -> DEAD_KAMI, no KamiSend
 *   #12 stage 3 ACTIVE, 2 actions of gas, 0 escrow, HARVESTING, Kamibots DELETE
 *       returns 503                                  -> EXIT_RESERVE_STOP +
 *       ESCROW_LOW, harvest stopped on-chain without Kamibots
 *   #13 stage 3 ACTIVE, healthy gas, renter prefs far below the floor
 *                                                    -> strategy started floored
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AbiCoder, Interface, Transaction, Wallet, getAddress, id as keccakId, keccak256, toBeHex } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const coder = AbiCoder.defaultAbiCoder();
const LATEST = 1_000;
const GAS_PRICE = 2_500_000n;
const ACTION_WEI = GAS_PRICE * 1_700_000n;
const ZERO = "0x0000000000000000000000000000000000000000";

const WORLD = "0x00000000000000000000000000000000000000a1";
const REGISTRY = "0x00000000000000000000000000000000000000a2";
const MARKET = "0x00000000000000000000000000000000000000a3";
const FACTORY = "0x00000000000000000000000000000000000000a4";
const OWNER = "0x00000000000000000000000000000000000000b1";
const RENTER = "0x00000000000000000000000000000000000000c1";
const KEEPER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const RES_TOKEN = "safety-smoke-token-".padEnd(40, "x");

const componentFor = (value) => getAddress(`0x${BigInt(value).toString(16).padStart(64, "0").slice(-40)}`).toLowerCase();
const registered = (name) => componentFor(BigInt(keccakId(name)));
const STATE_COMPONENT = registered("component.state");
const OWNS_COMPONENT = registered("component.id.kami.owns");
const HARVEST_STOP = registered("system.harvest.stop");
const KAMI_SEND = registered("system.kami.send");

const factoryIface = new Interface([
  "function requests(uint32) view returns (address renter,address pod,uint256 gasBudget,uint32 termSecs,uint64 requestedAt,uint8 stage)",
  "function keeper() view returns (address)",
  "function prefs(uint32) view returns (string)",
]);
const marketIface = new Interface([
  "function accID() view returns (uint256)",
  "function listings(uint32) view returns (tuple(address owner,uint256 kamiID,uint256 xpBase,uint16 ownerShareBps,uint128 minGasWei,bool staked,bool returning,bool ending,address renter,uint256 gasBudget,uint32 maxTermSecs,uint64 leaseStart,uint64 leaseEnd,address reservedFor))",
]);
const registryIface = new Interface(["function getEntitiesWithValue(uint256) view returns (uint256[])"]);
const podIface = new Interface(["function accID() view returns (uint256)"]);
const stateIface = new Interface(["function get(uint256) view returns (string)"]);
const ownsIface = new Interface(["function safeGet(uint256) view returns (uint256)"]);
const systemIface = new Interface(["function executeTyped(uint256) returns (bytes)"]);

const blockHash = (n) => keccak256(toBeHex(n, 32));

function scenario() {
  const leaseEnd = BigInt(Math.floor(Date.now() / 1000) + 86_400);
  const kamis = {
    11: { stage: 5, gasBudget: 0n, balance: ACTION_WEI * 10n, kamiState: "DEAD", prefs: "{}" },
    12: { stage: 3, gasBudget: 0n, balance: ACTION_WEI * 2n, kamiState: "HARVESTING", prefs: '{"risk":"safe"}', strategyStarted: true },
    13: {
      stage: 3,
      gasBudget: ACTION_WEI * 200n,
      balance: ACTION_WEI * 20n,
      kamiState: "HARVESTING",
      prefs: JSON.stringify({ risk: "aggressive", hpThresholdLow: 5, useHpBasedRest: false, enableFailsafeRest: false, farmInterval: 72_000 }),
    },
  };
  for (const [token, kami] of Object.entries(kamis)) {
    kami.token = Number(token);
    kami.kamiID = 5_000n + BigInt(token);
    kami.pod = `0x00000000000000000000000000000000000000${(0xd0 + Number(token)).toString(16)}`;
    kami.podAcc = 9_000n + BigInt(token);
    kami.operator = Wallet.createRandom();
    kami.leaseEnd = leaseEnd;
  }
  return kamis;
}

function mockChain(kamis) {
  const sent = [];
  const receipts = new Map();
  const byPod = Object.fromEntries(Object.values(kamis).map((k) => [k.pod.toLowerCase(), k]));
  const byKamiID = Object.fromEntries(Object.values(kamis).map((k) => [k.kamiID.toString(), k]));
  const byOperator = Object.fromEntries(Object.values(kamis).map((k) => [k.operator.address.toLowerCase(), k]));

  function call({ to, data }) {
    const target = to.toLowerCase();
    const selector = data.slice(0, 10);
    if (target === WORLD) return coder.encode(["address"], [REGISTRY]);
    if (target === REGISTRY) {
      const [value] = registryIface.decodeFunctionData("getEntitiesWithValue", data);
      return coder.encode(["uint256[]"], [[BigInt(componentFor(value))]]);
    }
    if (target === FACTORY) {
      if (selector === factoryIface.getFunction("keeper").selector) {
        return coder.encode(["address"], [new Wallet(KEEPER_KEY).address]);
      }
      if (selector === factoryIface.getFunction("prefs").selector) {
        const [token] = factoryIface.decodeFunctionData("prefs", data);
        return factoryIface.encodeFunctionResult("prefs", [kamis[Number(token)].prefs]);
      }
      const [token] = factoryIface.decodeFunctionData("requests", data);
      const kami = kamis[Number(token)];
      return factoryIface.encodeFunctionResult("requests", [RENTER, kami.pod, kami.gasBudget, 86_400, 0, kami.stage]);
    }
    if (target === MARKET) {
      if (selector === marketIface.getFunction("accID").selector) return coder.encode(["uint256"], [555n]);
      const [token] = marketIface.decodeFunctionData("listings", data);
      const kami = kamis[Number(token)];
      return marketIface.encodeFunctionResult("listings", [
        [OWNER, kami.kamiID, 0n, 7000, 0n, true, false, false, RENTER, 0n, 86_400 * 7, 0n, kami.leaseEnd, ZERO],
      ]);
    }
    if (byPod[target]) return podIface.encodeFunctionResult("accID", [byPod[target].podAcc]);
    if (target === STATE_COMPONENT) {
      const [kamiID] = stateIface.decodeFunctionData("get", data);
      return stateIface.encodeFunctionResult("get", [byKamiID[kamiID.toString()].kamiState]);
    }
    if (target === OWNS_COMPONENT) {
      const [kamiID] = ownsIface.decodeFunctionData("safeGet", data);
      return ownsIface.encodeFunctionResult("safeGet", [byKamiID[kamiID.toString()].podAcc]);
    }
    if (target === HARVEST_STOP) return systemIface.encodeFunctionResult("executeTyped", ["0x"]);
    throw new Error(`unexpected eth_call to ${to} ${selector}`);
  }

  function block(tag) {
    const n = tag === "latest" || tag === "pending" ? LATEST : Number(tag);
    return {
      number: toBeHex(n),
      hash: blockHash(n),
      parentHash: blockHash(n - 1),
      timestamp: toBeHex(1_790_000_000 + n),
      nonce: "0x0000000000000000",
      difficulty: "0x0",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      miner: ZERO,
      extraData: "0x",
      baseFeePerGas: "0x0",
      transactions: [],
    };
  }

  function sendRaw(raw) {
    const tx = Transaction.from(raw);
    const hash = tx.hash;
    const to = String(tx.to).toLowerCase();
    sent.push({ hash, to, from: tx.from.toLowerCase(), data: tx.data });
    // The chain applies the harvest stop: the Kami is RESTING from now on.
    if (to === HARVEST_STOP) {
      const [harvestID] = systemIface.decodeFunctionData("executeTyped", tx.data);
      assert.ok(harvestID > 0n);
      byOperator[tx.from.toLowerCase()].kamiState = "RESTING";
    }
    receipts.set(hash, {
      transactionHash: hash,
      transactionIndex: "0x0",
      blockHash: blockHash(LATEST),
      blockNumber: toBeHex(LATEST),
      from: tx.from,
      to: tx.to,
      contractAddress: null,
      cumulativeGasUsed: "0x19f0a0",
      gasUsed: "0x19f0a0",
      effectiveGasPrice: toBeHex(GAS_PRICE),
      logs: [],
      logsBloom: `0x${"00".repeat(256)}`,
      status: "0x1",
      type: toBeHex(tx.type ?? 0),
    });
    return hash;
  }

  function handle({ id, method, params }) {
    const ok = (result) => ({ id, jsonrpc: "2.0", result });
    switch (method) {
      case "eth_chainId":
        return ok("0x1");
      case "eth_blockNumber":
        return ok(toBeHex(LATEST));
      case "eth_getBlockByNumber":
        return ok(block(params[0]));
      case "eth_getLogs":
        return ok([]);
      case "eth_call":
        return ok(call(params[0]));
      case "eth_getBalance": {
        const kami = byOperator[String(params[0]).toLowerCase()];
        return ok(toBeHex(kami ? kami.balance : 0n));
      }
      case "eth_gasPrice":
        return ok(toBeHex(GAS_PRICE));
      case "eth_maxPriorityFeePerGas":
        return ok("0x0");
      case "eth_estimateGas":
        return ok(toBeHex(1_700_000n));
      case "eth_getTransactionCount":
        return ok("0x0");
      case "eth_sendRawTransaction":
        return ok(sendRaw(params[0]));
      case "eth_getTransactionReceipt":
        return ok(receipts.get(params[0]) ?? null);
      case "eth_getTransactionByHash":
        return ok(null);
      default:
        return { id, jsonrpc: "2.0", error: { code: -32601, message: `mock: ${method} not supported` } };
    }
  }

  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const run = (one) => {
      try {
        return handle(one);
      } catch (error) {
        return { id: one.id, jsonrpc: "2.0", error: { code: -32000, message: String(error.message) } };
      }
    };
    const result = Array.isArray(payload) ? payload.map(run) : run(payload);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result));
  });
  return { server, sent };
}

/** Kamibots: strategy starts succeed and are recorded; every stop is a 503. */
function mockKamibots() {
  const starts = [];
  const deletes = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.method === "POST" && request.url === "/api/strategies/start") {
      starts.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    if (request.method === "DELETE") deletes.push(request.url);
    response.writeHead(503, { "Content-Type": "text/plain" });
    response.end("kamibots down");
  });
  return { server, starts, deletes };
}

async function waitFor(predicate, timeoutMs, describe) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${typeof describe === "function" ? describe() : describe}`);
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

test("real worker: DEAD Kami held, exit reserve stops harvest without Kamibots, prefs floored", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-safety-"));
  const kamis = scenario();
  const chain = mockChain(kamis);
  const kamibots = mockKamibots();
  const rpc = await listen(chain.server);
  const kamibotsUrl = await listen(kamibots.server);
  const stateFile = join(dir, "renter-pod-worker-state.json");
  const jobs = {};
  for (const kami of Object.values(kamis)) {
    jobs[kami.token] = {
      tokenIndex: kami.token,
      renter: RENTER,
      node: 34,
      pod: kami.pod,
      operator: kami.operator.address,
      operatorKey: kami.operator.privateKey,
      nonce: `0x${kami.token.toString(16).padStart(64, "0")}`,
      creds: { apiKey: `key-${kami.token}`, privyId: `privy-${kami.token}`, regAddress: ZERO, operatorAddress: kami.operator.address },
      strategyStarted: Boolean(kami.strategyStarted),
      ...(kami.strategyStarted ? { strategySignature: "legacy-signature" } : {}),
      finalized: false,
      returned: false,
      error: null,
    };
  }
  writeFileSync(stateFile, JSON.stringify({ lastBlock: LATEST - 11, jobs, reservations: {} }, null, 2));

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
      OPERATOR_RESERVATION_PORT: String(20_000 + Math.floor(Math.random() * 20_000)),
      WORKER_STATE_FILE: stateFile,
      KAMIBOTS_API: kamibotsUrl,
      TERMINAL_GAS_RETURN_MODE: "skip",
      POLL_MS: "1000",
    },
  });
  // SIGTERM compacts the quote key store: wait for it before removing the dir.
  const childExit = new Promise((resolve) => child.once("exit", resolve));
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  try {
    const heartbeatFile = join(dir, "heartbeat.json");
    await waitFor(() => existsSync(heartbeatFile), 30_000, () => `heartbeat.json; worker output:\n${output}`);
    // Let a second tick run: the exit hold and the DEAD hold must be stable.
    const first = JSON.parse(readFileSync(heartbeatFile, "utf8")).ts;
    await waitFor(() => JSON.parse(readFileSync(heartbeatFile, "utf8")).ts > first || /tick failed/.test(output), 10_000, () => `second tick; output:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.doesNotMatch(output, /tick failed/);
    assert.match(output, /lease safety: prefsFloor=hpLow>=45/);

    // #11: DEAD in its pod at refund stage -> alerted and held, never KamiSent.
    assert.match(output, new RegExp(`\\[LEASE-ALERT\\] DEAD_KAMI token=11 market=${MARKET} stage=5 action=kamiSend`));
    assert.equal(state.jobs[11].dead.stage, 5);
    assert.equal(state.jobs[11].returned, false);
    assert.equal(state.jobs[11].error, null, "held, not erroring every tick");
    assert.equal(chain.sent.filter((tx) => tx.to === KAMI_SEND).length, 0, "no doomed KamiSend");

    // #12: exit reserve. Kamibots DELETE failed, harvest stopped on-chain anyway.
    assert.match(output, new RegExp(`\\[LEASE-ALERT\\] EXIT_RESERVE_STOP token=12 market=${MARKET} stage=3`));
    assert.match(output, /\[LEASE-ALERT\] ESCROW_LOW token=12 .*reason=exit-reserve/);
    assert.equal((output.match(/EXIT_RESERVE_STOP token=12/g) ?? []).length, 1, "entry alert once");
    const stops = chain.sent.filter((tx) => tx.to === HARVEST_STOP);
    assert.equal(stops.length, 1, "exactly one harvest stop; the next tick sees RESTING");
    assert.equal(stops[0].from, kamis[12].operator.address.toLowerCase());
    assert.ok(kamibots.deletes.some((url) => url === "/api/strategies/kami/12"), "Kamibots stop was attempted");
    assert.ok(state.jobs[12].exitReserve, "job marked as held on its exit reserve");
    assert.ok(state.jobs[12].kamibotsStop.bypassedAt, "on-chain stop did not wait for Kamibots");
    assert.equal(kamis[12].kamiState, "RESTING");
    assert.equal(kamibots.starts.filter((body) => body.kamiId === 12).length, 0, "strategy not restarted");

    // #13: floored prefs reached Kamibots; the clamp is recorded on the job.
    const start13 = kamibots.starts.find((body) => body.kamiId === 13);
    assert.ok(start13, `strategy started for #13; output:\n${output}`);
    assert.equal(start13.strategyType, "harvestAndRest");
    assert.equal(start13.config.useHpBasedRest, true);
    assert.equal(start13.config.hpThresholdLow, 45);
    assert.equal(kamibots.starts.filter((body) => body.kamiId === 13).length, 1, "no restart storm");
    assert.match(state.jobs[13].prefsClamped.summary, /risk aggressive->balanced/);
    assert.equal(state.jobs[13].strategyStarted, true);
    assert.equal(state.jobs[13].appliedPrefs.hpThresholdLow, 45);
  } finally {
    child.kill("SIGTERM");
    await childExit;
    await new Promise((resolve) => chain.server.close(resolve));
    await new Promise((resolve) => kamibots.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
