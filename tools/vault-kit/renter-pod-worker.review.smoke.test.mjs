/**
 * Process-level smoke test for the review fixes: runs the REAL
 * renter-pod-worker.mjs against an in-process mock JSON-RPC node (EIP-1559
 * blocks: baseFee = gasPrice, so ethers sends maxFeePerGas = 2 x gasPrice) and
 * a mock Kamibots API. No network, no chain, throwaway keys.
 *
 *   #21 stage 3 ACTIVE, 6 gasPrice-priced actions of gas, 0 escrow, HARVESTING.
 *       Priced at gasPrice (old) that is above the 4-action exit trigger; priced
 *       at the billed maxFeePerGas it is below -> EXIT_RESERVE_STOP + harvest stop.
 *   #22 stage 3 ACTIVE, healthy escrow, pullGas needed. The node ACCEPTS the
 *       pullGas but answers eth_sendRawTransaction after the client timeout,
 *       then keeps it pending (and getTransactionByHash flakes to null) for a
 *       few seconds -> exactly ONE pullGas ever reaches the node.
 *   #23 stage 2, Kami at the hub. The factory request flips to another pod
 *       between processJob's read and the keeper send -> routePreparedKami is
 *       never sent (keeper preflight).
 *   #24 stage 2, Kami in its pod, HARVESTING, no Kamibots creds -> registers,
 *       starts the strategy, activates.
 *   Ingest backlog of 450 blocks with LOG_CHUNK_BLOCKS=100 -> every
 *       eth_getLogs range <= 100 blocks, contiguous, cursor reaches the tip.
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
const CONFIRMED_TIP = LATEST - 12;
const GAS_PRICE = 2_500_000n;
const ACTION_WEI = GAS_PRICE * 1_700_000n; // the old (gasPrice) pricing of one action
const ZERO = "0x0000000000000000000000000000000000000000";
const MARKET_ACC = 555n;

const WORLD = "0x00000000000000000000000000000000000000a1";
const REGISTRY = "0x00000000000000000000000000000000000000a2";
const MARKET = "0x00000000000000000000000000000000000000a3";
const FACTORY = "0x00000000000000000000000000000000000000a4";
const OWNER = "0x00000000000000000000000000000000000000b1";
const RENTER = "0x00000000000000000000000000000000000000c1";
const OTHER_POD = "0x00000000000000000000000000000000000000ee";
const KEEPER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const RES_TOKEN = "review-smoke-token-".padEnd(40, "x");

const componentFor = (value) => getAddress(`0x${BigInt(value).toString(16).padStart(64, "0").slice(-40)}`).toLowerCase();
const registered = (name) => componentFor(BigInt(keccakId(name)));
const STATE_COMPONENT = registered("component.state");
const OWNS_COMPONENT = registered("component.id.kami.owns");
const HARVEST_STOP = registered("system.harvest.stop");

const factoryIface = new Interface([
  "function requests(uint32) view returns (address renter,address pod,uint256 gasBudget,uint32 termSecs,uint64 requestedAt,uint8 stage)",
  "function keeper() view returns (address)",
  "function prefs(uint32) view returns (string)",
  "function pullGas(uint32,uint256)",
  "function routePreparedKami(uint32)",
  "function activateProvisionedLease(uint32)",
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
const selector = (name) => factoryIface.getFunction(name).selector;

const blockHash = (n) => keccak256(toBeHex(n, 32));

function scenario() {
  const leaseEnd = BigInt(Math.floor(Date.now() / 1000) + 86_400);
  const kamis = {
    21: { stage: 3, gasBudget: 0n, balance: ACTION_WEI * 6n, kamiState: "HARVESTING", prefs: '{"risk":"safe"}', strategyStarted: true },
    22: { stage: 3, gasBudget: ACTION_WEI * 200n, balance: ACTION_WEI * 5n, kamiState: "HARVESTING", prefs: '{"risk":"safe"}' },
    23: { stage: 2, gasBudget: ACTION_WEI * 50n, balance: ACTION_WEI * 50n, kamiState: "RESTING", prefs: "{}", atHub: true, flipPod: true },
    24: { stage: 2, gasBudget: ACTION_WEI * 50n, balance: ACTION_WEI * 50n, kamiState: "HARVESTING", prefs: '{"risk":"safe"}', noCreds: true },
  };
  for (const [token, kami] of Object.entries(kamis)) {
    kami.token = Number(token);
    kami.kamiID = 6_000n + BigInt(token);
    kami.pod = `0x00000000000000000000000000000000000000${(0xd0 + Number(token)).toString(16)}`;
    kami.podAcc = 9_000n + BigInt(token);
    kami.operator = Wallet.createRandom();
    kami.leaseEnd = leaseEnd;
    kami.requestReads = 0;
  }
  return kamis;
}

function mockChain(kamis) {
  const sent = [];
  const receipts = new Map();
  const pending = new Map(); // hash -> { minesAt, apply }
  const logRanges = [];
  // Like a real node: "pending" nonce counts mempool txs, "latest" only mined.
  const accepted = new Map();
  const mined = new Map();
  const bump = (map, from) => map.set(from, (map.get(from) ?? 0) + 1);
  const byPod = Object.fromEntries(Object.values(kamis).map((k) => [k.pod.toLowerCase(), k]));
  const byKamiID = Object.fromEntries(Object.values(kamis).map((k) => [k.kamiID.toString(), k]));
  const byOperator = Object.fromEntries(Object.values(kamis).map((k) => [k.operator.address.toLowerCase(), k]));

  function mine() {
    for (const [hash, entry] of pending) {
      if (Date.now() < entry.minesAt) continue;
      pending.delete(hash);
      entry.apply();
      receipts.set(hash, entry.receipt);
      bump(mined, entry.from);
    }
  }

  function call({ to, data }) {
    const target = to.toLowerCase();
    const sel = data.slice(0, 10);
    if (target === WORLD) return coder.encode(["address"], [REGISTRY]);
    if (target === REGISTRY) {
      const [value] = registryIface.decodeFunctionData("getEntitiesWithValue", data);
      return coder.encode(["uint256[]"], [[BigInt(componentFor(value))]]);
    }
    if (target === FACTORY) {
      if (sel === selector("keeper")) return coder.encode(["address"], [new Wallet(KEEPER_KEY).address]);
      if (sel === selector("prefs")) {
        const [token] = factoryIface.decodeFunctionData("prefs", data);
        return factoryIface.encodeFunctionResult("prefs", [kamis[Number(token)].prefs]);
      }
      const [token] = factoryIface.decodeFunctionData("requests", data);
      const kami = kamis[Number(token)];
      kami.requestReads++;
      // #23: every second read (the keeper preflight) sees a NEWER request.
      const pod = kami.flipPod && kami.requestReads % 2 === 0 ? OTHER_POD : kami.pod;
      return factoryIface.encodeFunctionResult("requests", [RENTER, pod, kami.gasBudget, 86_400, 0, kami.stage]);
    }
    if (target === MARKET) {
      if (sel === marketIface.getFunction("accID").selector) return coder.encode(["uint256"], [MARKET_ACC]);
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
      const kami = byKamiID[kamiID.toString()];
      return ownsIface.encodeFunctionResult("safeGet", [kami.atHub ? MARKET_ACC : kami.podAcc]);
    }
    if (target === HARVEST_STOP) return systemIface.encodeFunctionResult("executeTyped", ["0x"]);
    throw new Error(`unexpected eth_call to ${to} ${sel}`);
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
      baseFeePerGas: toBeHex(GAS_PRICE),
      transactions: [],
    };
  }

  function receiptFor(tx) {
    return {
      transactionHash: tx.hash,
      transactionIndex: "0x0",
      blockHash: blockHash(LATEST),
      blockNumber: toBeHex(LATEST),
      from: tx.from,
      to: tx.to,
      contractAddress: null,
      cumulativeGasUsed: "0x19f0a0",
      gasUsed: "0x19f0a0",
      effectiveGasPrice: toBeHex(GAS_PRICE * 2n),
      logs: [],
      logsBloom: `0x${"00".repeat(256)}`,
      status: "0x1",
      type: toBeHex(tx.type ?? 0),
    };
  }

  /** Returns { hash, delayMs } - delayMs > 0 answers after the client timeout. */
  function sendRaw(raw) {
    const tx = Transaction.from(raw);
    const hash = tx.hash;
    if (receipts.has(hash) || pending.has(hash)) return { hash, delayMs: 0 }; // rebroadcast: idempotent
    const to = String(tx.to).toLowerCase();
    const from = tx.from.toLowerCase();
    sent.push({ hash, to, from, data: tx.data, selector: tx.data.slice(0, 10), type: tx.type, nonce: tx.nonce });
    bump(accepted, from);
    const kami = byOperator[from];
    if (to === FACTORY && tx.data.startsWith(selector("pullGas"))) {
      // Accepted, but the answer arrives after FETCH_TIMEOUT_MS and the tx sits
      // in the mempool (invisible to getTransactionByHash) for 5 s.
      const [, amount] = factoryIface.decodeFunctionData("pullGas", tx.data);
      pending.set(hash, {
        from,
        minesAt: Date.now() + 5_000,
        receipt: receiptFor(tx),
        apply: () => {
          kami.balance += amount;
          kami.gasBudget -= amount;
        },
      });
      return { hash, delayMs: 3_000 };
    }
    if (to === HARVEST_STOP) byOperator[from].kamiState = "RESTING";
    receipts.set(hash, receiptFor(tx));
    bump(mined, from);
    return { hash, delayMs: 0 };
  }

  async function handle({ id, method, params }) {
    const ok = (result) => ({ id, jsonrpc: "2.0", result });
    mine();
    switch (method) {
      case "eth_chainId":
        return ok("0x1");
      case "eth_blockNumber":
        return ok(toBeHex(LATEST));
      case "eth_getBlockByNumber":
        return ok(block(params[0]));
      case "eth_getLogs":
        logRanges.push([Number(params[0].fromBlock), Number(params[0].toBlock)]);
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
      case "eth_getTransactionCount": {
        const from = String(params[0]).toLowerCase();
        return ok(toBeHex((params[1] === "pending" ? accepted : mined).get(from) ?? 0));
      }
      case "eth_sendRawTransaction": {
        const { hash, delayMs } = sendRaw(params[0]);
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return ok(hash);
      }
      case "eth_getTransactionReceipt":
        return ok(receipts.get(params[0]) ?? null);
      case "eth_getTransactionByHash":
        return ok(null); // flaky node: never shows mempool txs
      default:
        return { id, jsonrpc: "2.0", error: { code: -32601, message: `mock: ${method} not supported` } };
    }
  }

  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const run = async (one) => {
      try {
        return await handle(one);
      } catch (error) {
        return { id: one.id, jsonrpc: "2.0", error: { code: -32000, message: String(error.message) } };
      }
    };
    const result = Array.isArray(payload) ? await Promise.all(payload.map(run)) : await run(payload);
    if (response.destroyed) return;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result));
  });
  return { server, sent, logRanges };
}

function mockKamibots() {
  const starts = [];
  const deletes = [];
  const registrations = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const reply = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "POST" && request.url === "/api/agent/register") {
      registrations.push(JSON.parse(body));
      return reply(200, { apiKey: `key-new-${registrations.length}`, privyId: `privy-new-${registrations.length}` });
    }
    if (request.method === "POST" && request.url === "/api/agent/operator-key") return reply(200, { ok: true });
    if (request.method === "POST" && request.url === "/api/strategies/start") {
      starts.push(JSON.parse(body));
      return reply(200, { ok: true });
    }
    if (request.method === "DELETE") {
      deletes.push(request.url);
      return reply(200, { ok: true });
    }
    return reply(404, { error: "no" });
  });
  return { server, starts, deletes, registrations };
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

test("real worker: billed-fee exit reserve, no duplicate pullGas across a broadcast timeout, keeper preflight, chunked ingest", { timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-review-"));
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
      creds: kami.noCreds ? null : { apiKey: `key-${kami.token}`, privyId: `privy-${kami.token}`, regAddress: ZERO, operatorAddress: kami.operator.address },
      strategyStarted: Boolean(kami.strategyStarted),
      ...(kami.strategyStarted ? { strategySignature: "legacy-signature" } : {}),
      finalized: false,
      returned: false,
      error: null,
    };
  }
  // 450 blocks of backlog behind the confirmed tip.
  const startBlock = CONFIRMED_TIP - 449;
  writeFileSync(stateFile, JSON.stringify({ lastBlock: startBlock, jobs, reservations: {} }, null, 2));

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
      FETCH_TIMEOUT_MS: "1500",
      LOG_CHUNK_BLOCKS: "100",
      LOG_CHUNKS_PER_TICK: "2",
    },
  });
  // SIGTERM compacts the quote key store: wait for it before removing the dir.
  const childExit = new Promise((resolve) => child.once("exit", resolve));
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const pulls = () => chain.sent.filter((tx) => tx.to === FACTORY && tx.selector === selector("pullGas"));
  try {
    // #22 progresses only after its single pullGas is mined (~5 s) and cleared.
    await waitFor(
      () => kamibots.starts.some((body) => body.kamiId === 22),
      45_000,
      () => `strategy start for #22 after the pending pullGas cleared; output:\n${output}`
    );
    await waitFor(() => JSON.parse(readFileSync(stateFile, "utf8")).lastBlock === CONFIRMED_TIP + 1, 15_000, () => `ingest to reach the tip; output:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.doesNotMatch(output, /tick failed/);

    // #22: the broadcast timed out client-side, the tx stayed pending and
    // invisible; the worker waited (rebroadcasting the same bytes) instead of
    // sending a second pullGas under a new nonce.
    assert.equal(pulls().length, 1, `exactly one pullGas reached the node; sent: ${JSON.stringify(pulls())}`);
    assert.match(output, /\[LEASE-ALERT\] TX_TIMEOUT job=22:.* label=pullGas .*state=unseen-rebroadcast/);
    assert.equal(state.pendingTxs?.["22:" + jobs[22].nonce], undefined, "cleared once mined");
    assert.equal(pulls()[0].type, 2, "default pricing keeps ethers' EIP-1559 txs");

    // #21: priced at the billed maxFeePerGas (2 x gasPrice), 6 gasPrice-actions
    // is below the 4-action trigger -> the exit reserve fired.
    assert.match(output, new RegExp(`\\[LEASE-ALERT\\] EXIT_RESERVE_STOP token=21 market=${MARKET} stage=3`));
    assert.equal(chain.sent.filter((tx) => tx.to === HARVEST_STOP && tx.from === kamis[21].operator.address.toLowerCase()).length, 1);
    assert.ok(kamibots.deletes.includes("/api/strategies/kami/21"), "confirmed Kamibots stop");
    assert.ok(state.jobs[21].exitReserve);

    // #23: keeper preflight saw the request move to another pod: nothing sent.
    assert.equal(chain.sent.filter((tx) => tx.selector === selector("routePreparedKami")).length, 0);
    assert.match(output, /#23: routePreparedKami for Kami #23 aborted: the factory request now belongs to pod/);

    // #24: adopted at stage 2 without creds -> registered, started, activated.
    assert.equal(kamibots.registrations.length, 1);
    assert.equal(state.jobs[24].creds.apiKey, "key-new-1");
    assert.ok(kamibots.starts.some((body) => body.kamiId === 24));
    assert.equal(chain.sent.filter((tx) => tx.selector === selector("activateProvisionedLease")).length >= 1, true);

    // Chunked ingest: bounded, contiguous ranges from the backlog to the tip.
    const ranges = chain.logRanges;
    assert.ok(ranges.length >= 5, `ranges: ${JSON.stringify(ranges)}`);
    assert.ok(ranges.every(([from, to]) => to - from + 1 <= 100), JSON.stringify(ranges));
    assert.equal(ranges[0][0], startBlock);
    for (let i = 1; i < 5; i++) assert.equal(ranges[i][0], ranges[i - 1][1] + 1, "contiguous");
    assert.equal(ranges[4][1], CONFIRMED_TIP);
    assert.match(output, /ingest catching up: at block/);
  } finally {
    child.kill("SIGTERM");
    await childExit;
    await new Promise((resolve) => chain.server.close(resolve));
    await new Promise((resolve) => kamibots.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
