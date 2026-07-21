#!/usr/bin/env node
/**
 * v14 renter-funded RoomPod worker.
 *
 * The renter's factory transaction already deployed the pod and funded every
 * automation wallet. This worker contributes no ETH and has no admin path. It
 * only advances the factory's constrained state machine:
 *   register Kamibots -> walk pod -> owner pool to hub -> hub to pod ->
 *   start Kamibots -> activate paid clock -> stop/sweep/finalize -> owner pool.
 *
 * Required env:
 *   YOMINET_RPC, WORLD_ADDR, MARKET_ADDRESS, RENTER_POD_FACTORY
 *   PROVISIONING_PRIVATE_KEY  (must equal market operator + factory signer)
 *   PROVISIONING_OPERATOR_SEED (same server-only seed used by quote API)
 * Optional: KAMIBOTS_API, KAMISTATS_URL, POLL_MS, START_BLOCK, WORKER_STATE_FILE
 */
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, id as keccakId } from "ethers";
import {
  buildKamibotsStartBody,
  kamibotsStrategySignature,
  normalizeKamibotsPrefs,
} from "./kamibots-rental-config.mjs";
import { StageZeroAction, stageZeroAction } from "./renter-pod-recovery.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const RPC = required("YOMINET_RPC");
const WORLD = required("WORLD_ADDR");
const MARKET = required("MARKET_ADDRESS");
const FACTORY = required("RENTER_POD_FACTORY");
const PROVISIONER_KEY = required("PROVISIONING_PRIVATE_KEY");
const OPERATOR_SEED = required("PROVISIONING_OPERATOR_SEED");
const KAMIBOTS = process.env.KAMIBOTS_API || "https://api.kamibots.xyz";
const KAMISTATS = process.env.KAMISTATS_URL || "https://kamistats.com";
const POLL_MS = Number(process.env.POLL_MS || 30_000);
const STATE_FILE = process.env.WORKER_STATE_FILE || join(here, "renter-pod-worker-state.json");
const ZERO = "0x0000000000000000000000000000000000000000";

const provider = new JsonRpcProvider(RPC);
const provisioner = new Wallet(PROVISIONER_KEY, provider);
const world = new Contract(
  WORLD,
  ["function components() view returns (address)", "function systems() view returns (address)"],
  provider
);
const market = new Contract(
  MARKET,
  [
    "function accID() view returns (uint256)",
    "function operatorAddr() view returns (address)",
    "function listings(uint32) view returns (tuple(address owner,uint256 kamiID,uint256 xpBase,uint16 ownerShareBps,uint128 minGasWei,bool staked,bool returning,bool ending,address renter,uint256 gasBudget,uint32 maxTermSecs,uint64 leaseStart,uint64 leaseEnd,address reservedFor))",
    "function endLease(uint32)",
    "function clearReturned(uint32)",
    "function confirmReturnedToPool(uint32)",
  ],
  provider
);
const factory = new Contract(
  FACTORY,
  [
    "function requests(uint32) view returns (address renter,address pod,uint256 gasBudget,uint32 termSecs,uint64 requestedAt,uint8 stage)",
    "function prefs(uint32) view returns (string)",
    "function markLeasePreparing(uint32)",
    "function activateProvisionedLease(uint32)",
    "function pullGas(uint32,uint256)",
    "function finalizeMarketLease(uint32)",
    "function finalizePreparingCancellation(uint32)",
    "event RenterPodCreated(address indexed renter,uint32 indexed tokenIndex,uint32 indexed nodeIndex,address pod,address operator,uint256 setupGasWei,uint256 hubGasWei,uint256 operatingGasWei,bytes32 nonce)",
  ],
  provider
);
const POD_ABI = [
  "function accID() view returns (uint256)",
  "function sweepMusu() returns (uint256)",
  "function musuBalance() view returns (uint256)",
];
const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { lastBlock: Number(process.env.START_BLOCK || 0), jobs: {} };
state.jobs ??= {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });

let idOwnsKami;
let roomComponent;
let moveSystem;
let sendSystem;
let marketAccID;

function operatorWallet(nonce) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const key = createHmac("sha256", OPERATOR_SEED).update(`${nonce}:${attempt}`).digest("hex");
    try {
      return new Wallet(`0x${key}`, provider);
    } catch {}
  }
  throw new Error("could not derive operator key");
}

async function registryAddress(registry, name) {
  const rows = await registry.getEntitiesWithValue(BigInt(keccakId(name)));
  if (!rows.length) throw new Error(`registry entry missing: ${name}`);
  return `0x${rows[0].toString(16).padStart(40, "0")}`;
}

async function wire() {
  const [componentsAddress, systemsAddress, onChainOperator] = await Promise.all([
    world.components(),
    world.systems(),
    market.operatorAddr(),
  ]);
  if (String(onChainOperator).toLowerCase() !== provisioner.address.toLowerCase()) {
    throw new Error(`PROVISIONING_PRIVATE_KEY is not market operator ${onChainOperator}`);
  }
  const registryAbi = ["function getEntitiesWithValue(uint256) view returns (uint256[])"];
  const components = new Contract(componentsAddress, registryAbi, provider);
  const systems = new Contract(systemsAddress, registryAbi, provider);
  idOwnsKami = new Contract(
    await registryAddress(components, "component.id.kami.owns"),
    ["function safeGet(uint256) view returns (uint256)"],
    provider
  );
  roomComponent = new Contract(
    await registryAddress(components, "component.index.room"),
    ["function get(uint256) view returns (uint32)"],
    provider
  );
  moveSystem = new Contract(
    await registryAddress(systems, "system.account.move"),
    ["function executeTyped(uint32) returns (bytes)"],
    provider
  );
  sendSystem = new Contract(
    await registryAddress(systems, "system.kami.send"),
    ["function executeTyped(uint32,address) returns (bytes)"],
    provider
  );
  marketAccID = await market.accID();
}

async function kb(path, { method = "GET", body, apiKey } = {}) {
  const response = await fetch(`${KAMIBOTS}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "X-Agent-Key": apiKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 180)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function registerKamibots(operator) {
  const registration = Wallet.createRandom();
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `Register for Kamibots: ${timestamp}`;
  const result = await kb("/api/agent/register", {
    method: "POST",
    body: {
      walletAddress: registration.address,
      signature: await registration.signMessage(message),
      message,
      label: "renter-funded-roompod",
    },
  });
  await kb("/api/agent/operator-key", {
    method: "POST",
    apiKey: result.apiKey,
    body: { operatorKey: operator.privateKey },
  });
  return {
    apiKey: result.apiKey,
    privyId: result.privyId,
    regAddress: registration.address,
    operatorAddress: operator.address,
  };
}

async function tileFor(job) {
  const response = await fetch(`${KAMISTATS}/api/vault/lease-tiles?market=${MARKET}`);
  if (!response.ok) throw new Error(`tile catalog -> ${response.status}`);
  const data = await response.json();
  const tile = data.tiles?.find((row) => Number(row.node) === Number(job.node));
  if (!tile) throw new Error(`node ${job.node} no longer farmable`);
  return tile;
}

async function walk(job, operator, accID) {
  job.tile ??= await tileFor(job);
  let current = Number(await roomComponent.get(accID));
  const route = current === 1
    ? job.tile.path
    : job.tile.path.slice(Math.max(0, job.tile.path.indexOf(current) + 1));
  for (const room of route) {
    if (current === Number(job.tile.room)) break;
    await (await moveSystem.connect(operator).executeTyped(Number(room))).wait();
    current = Number(await roomComponent.get(accID));
    if (current !== Number(room)) throw new Error(`walk expected room ${room}, got ${current}`);
  }
  if (current !== Number(job.tile.room)) throw new Error(`pod stopped in room ${current}`);
}

async function ingestEvents() {
  const latest = await provider.getBlockNumber();
  if (!state.lastBlock) state.lastBlock = Math.max(0, latest - 2_000);
  if (state.lastBlock > latest) return;
  const events = await factory.queryFilter(
    factory.filters.RenterPodCreated(),
    state.lastBlock,
    latest
  );
  for (const event of events) {
    const args = event.args;
    const tokenIndex = Number(args.tokenIndex);
    state.jobs[tokenIndex] ??= {
      tokenIndex,
      renter: String(args.renter),
      node: Number(args.nodeIndex),
      pod: String(args.pod),
      operator: String(args.operator),
      nonce: String(args.nonce),
      creds: null,
      strategyStarted: false,
      finalized: false,
      returned: false,
      eventBlock: event.blockNumber,
    };
  }
  state.lastBlock = latest + 1;
  save();
}

async function ensureOperatorGas(tokenIndex, request, operator) {
  const balance = await provider.getBalance(operator.address);
  const reserve = 1_000_000_000_000n;
  if (balance >= reserve || request.gasBudget === 0n) return;
  const amount = request.gasBudget < reserve ? request.gasBudget : reserve;
  await (await factory.connect(operator).pullGas(tokenIndex, amount)).wait();
}

async function stopStrategy(job) {
  if (!job.strategyStarted || !job.creds) return;
  try {
    await kb(`/api/strategies/kami/${job.tokenIndex}`, {
      method: "DELETE",
      apiKey: job.creds.apiKey,
      body: { keyData: { privy_id: job.creds.privyId } },
    });
  } catch (error) {
    if (!/404/.test(String(error))) throw error;
  }
  job.strategyStarted = false;
}

function normalizeJobPrefs(job, rawPrefs) {
  return normalizeKamibotsPrefs(rawPrefs, {
    defaultNode: job.node,
    botNodes: new Set([job.node]),
    selfNodes: new Set(),
  });
}

async function startStrategy(job, prefs) {
  await kb("/api/strategies/start", {
    method: "POST",
    apiKey: job.creds.apiKey,
    body: buildKamibotsStartBody(
      { node: job.node, creds: job.creds },
      job.tokenIndex,
      prefs
    ),
  });
  job.strategyStarted = true;
  job.strategySignature = kamibotsStrategySignature(prefs);
  save();
}

async function reconcileStrategy(job) {
  const rawPrefs = JSON.parse(await factory.prefs(job.tokenIndex));
  const prefs = normalizeJobPrefs(job, rawPrefs);
  const desired = kamibotsStrategySignature(prefs);
  if (job.strategyStarted && job.strategySignature === desired) return;
  if (job.strategyStarted) await stopStrategy(job);
  await startStrategy(job, prefs);
}

async function processJob(job) {
  const operator = operatorWallet(job.nonce);
  if (operator.address.toLowerCase() !== job.operator.toLowerCase()) {
    throw new Error("derived operator does not match the renter-signed quote");
  }
  const pod = new Contract(job.pod, POD_ABI, provider);
  const [request, listing, podAccID] = await Promise.all([
    factory.requests(job.tokenIndex),
    market.listings(job.tokenIndex),
    pod.accID(),
  ]);
  const stage = Number(request.stage);
  const actualAccID = await idOwnsKami.safeGet(listing.kamiID);

  if (stage === 1) {
    if (!job.creds) {
      job.creds = await registerKamibots(operator);
      save();
    }
    await walk(job, operator, podAccID);
    await (await factory.connect(provisioner).markLeasePreparing(job.tokenIndex)).wait();
    return;
  }

  if (stage === 2) {
    if (actualAccID === marketAccID) {
      await (await sendSystem.connect(provisioner).executeTyped(job.tokenIndex, operator.address)).wait();
      return;
    }
    if (actualAccID !== podAccID) return;
    await ensureOperatorGas(job.tokenIndex, request, operator);
    await reconcileStrategy(job);
    await (await factory.connect(provisioner).activateProvisionedLease(job.tokenIndex)).wait();
    return;
  }

  if (stage === 3) {
    await ensureOperatorGas(job.tokenIndex, request, operator);
    await reconcileStrategy(job);
    const now = Math.floor(Date.now() / 1000);
    if (!listing.ending && Number(listing.leaseEnd) > 0 && now > Number(listing.leaseEnd)) {
      await (await market.connect(operator).endLease(job.tokenIndex)).wait();
      return;
    }
    if (listing.ending) {
      await stopStrategy(job);
      await (await pod.connect(operator).sweepMusu()).wait();
      await (await factory.connect(operator).finalizeMarketLease(job.tokenIndex)).wait();
      job.finalized = true;
      save();
    }
    return;
  }

  if (stage === 4) {
    await stopStrategy(job);
    if (actualAccID === podAccID) {
      await (await sendSystem.connect(operator).executeTyped(job.tokenIndex, listing.owner)).wait();
      return;
    }
    if (actualAccID === marketAccID) {
      await (await sendSystem.connect(provisioner).executeTyped(job.tokenIndex, listing.owner)).wait();
      return;
    }
    if (actualAccID === BigInt(listing.owner)) {
      await (await factory.connect(operator).finalizePreparingCancellation(job.tokenIndex)).wait();
      job.returned = true;
      save();
    }
    return;
  }

  // A deleted request is durable proof that finalization or cancellation has
  // happened. Rebuild the remaining return work from on-chain custody instead
  // of trusting local flags that disappear when the worker state file is lost.
  if (stage === 0 && !job.returned) {
    job.finalized = true;
    const action = stageZeroAction({
      actualAccID,
      podAccID,
      ownerAccID: BigInt(listing.owner),
      staked: Boolean(listing.staked),
      returning: Boolean(listing.returning),
    });
    if (action === StageZeroAction.RETURN_FROM_POD) {
      await stopStrategy(job);
      await (await sendSystem.connect(operator).executeTyped(job.tokenIndex, listing.owner)).wait();
      save();
      return;
    }
    if (action === StageZeroAction.CLEAR_OWNER_RETURN) {
      await (await market.connect(operator).clearReturned(job.tokenIndex)).wait();
    } else if (action === StageZeroAction.CONFIRM_POOL_RETURN) {
      await (await market.connect(operator).confirmReturnedToPool(job.tokenIndex)).wait();
    } else if (action === StageZeroAction.WAIT) {
      save();
      return;
    }
    job.returned = true;
    save();
  }
}

async function tick() {
  await ingestEvents();
  for (const job of Object.values(state.jobs)) {
    try {
      await processJob(job);
      job.error = null;
    } catch (error) {
      job.error = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
      console.error(`#${job.tokenIndex}: ${job.error}`);
    }
  }
  save();
}

await wire();
console.log(`renter-funded worker ready: market ${MARKET}, factory ${FACTORY}, operator ${provisioner.address}`);
for (;;) {
  const started = Date.now();
  await tick().catch((error) => console.error("tick failed:", error.message || error));
  await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, POLL_MS - (Date.now() - started))));
}
