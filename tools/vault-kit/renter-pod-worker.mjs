#!/usr/bin/env node
/**
 * v15 renter-funded RoomPod worker.
 *
 * The renter's factory transaction already deployed the pod and funded every
 * automation wallet. This worker contributes no ETH and has no admin path. It
 * only advances the factory's constrained state machine:
 *   register Kamibots -> walk pod -> owner pool to hub -> hub to pod ->
 *   start Kamibots -> activate paid clock -> stop/sweep/finalize -> owner pool.
 *
 * Required env:
 *   YOMINET_RPC, WORLD_ADDR, MARKET_ADDRESS, RENTER_POD_FACTORY
 *   KEEPER_PRIVATE_KEY        (must equal the factory's immutable keeper)
 *   OPERATOR_RESERVATION_TOKEN (shared only with the quote API, 32+ chars)
 * Optional: LEGACY_PROVISIONING_OPERATOR_SEED (migration only),
 *   OPERATOR_RESERVATION_HOST, OPERATOR_RESERVATION_PORT,
 *   KAMIBOTS_API, KAMISTATS_URL, POLL_MS, START_BLOCK, WORKER_STATE_FILE
 */
import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, id as keccakId } from "ethers";
import {
  buildKamibotsStartBody,
  kamibotsStrategySignature,
  normalizeKamibotsPrefs,
} from "./kamibots-rental-config.mjs";
import {
  StageZeroAction,
  operatorGasHealth,
  operatorGasReturnAmount,
  stageZeroAction,
} from "./renter-pod-recovery.mjs";
import {
  bindOperatorReservationQuote,
  claimOperatorReservation,
  initializeOperatorKeyState,
  migrateLegacyJobKeys,
  operatorWalletForJob,
  purgeReturnedJobSecrets,
  removeExpiredUnclaimedReservations,
  reserveRandomOperator,
} from "./renter-pod-keys.mjs";

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
const KEEPER_KEY = required("KEEPER_PRIVATE_KEY");
const RESERVATION_TOKEN = required("OPERATOR_RESERVATION_TOKEN");
if (RESERVATION_TOKEN.length < 32) throw new Error("OPERATOR_RESERVATION_TOKEN must be at least 32 characters");
const LEGACY_OPERATOR_SEED = process.env.LEGACY_PROVISIONING_OPERATOR_SEED || "";
const KAMIBOTS = process.env.KAMIBOTS_API || "https://api.kamibots.xyz";
const KAMISTATS = process.env.KAMISTATS_URL || "https://kamistats.com";
const POLL_MS = Number(process.env.POLL_MS || 30_000);
const STATE_FILE = process.env.WORKER_STATE_FILE || join(here, "renter-pod-worker-state.json");
// Measured operating calls use ~1,611,833 gas. The default leaves a small
// regression margin while still checking the current network gas price.
const OPERATOR_ACTION_GAS_FLOOR = BigInt(process.env.OPERATOR_ACTION_GAS_FLOOR || "1700000");
// Roughly seven measured actions, matching the worker's observed daily cadence.
// The wei reserve is calculated from the live gas price instead of assuming
// Yominet will remain fixed at 2.5 Mwei.
const OPERATOR_RESERVE_GAS_UNITS = BigInt(process.env.OPERATOR_RESERVE_GAS_UNITS || "12000000");
if (OPERATOR_ACTION_GAS_FLOOR <= 0n) {
  throw new Error("OPERATOR_ACTION_GAS_FLOOR must be a positive integer");
}
if (OPERATOR_RESERVE_GAS_UNITS < OPERATOR_ACTION_GAS_FLOOR) {
  throw new Error("OPERATOR_RESERVE_GAS_UNITS must cover at least one operator action");
}
const RESERVATION_HOST = process.env.OPERATOR_RESERVATION_HOST || "127.0.0.1";
const RESERVATION_PORT = Number(process.env.OPERATOR_RESERVATION_PORT || 8789);
const ZERO = "0x0000000000000000000000000000000000000000";

const provider = new JsonRpcProvider(RPC);
const keeper = new Wallet(KEEPER_KEY, provider);
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
    "function keeper() view returns (address)",
    "function quoteDigest((address renter,uint32 tokenIndex,uint32 nodeIndex,address operator,uint16 expectedOwnerShareBps,uint32 termSecs,uint128 setupGasWei,uint128 hubGasWei,uint128 operatingGasWei,uint64 deadline,bytes32 nonce,string label,string accountName,string prefs)) view returns (bytes32)",
    "function prefs(uint32) view returns (string)",
    "function markLeasePreparing(uint32)",
    "function routePreparedKami(uint32)",
    "function activateProvisionedLease(uint32)",
    "function pullGas(uint32,uint256)",
    "function returnGas(uint32) payable",
    "function finalizeMarketLease(uint32)",
    "function finalizeGasRefund(uint32)",
    "function finalizePreparingCancellation(uint32)",
    "function recoverPreparingFromHub(uint32)",
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
initializeOperatorKeyState(state);
const save = () => {
  const temp = `${STATE_FILE}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, STATE_FILE);
};
const migratedLegacyJobs = migrateLegacyJobKeys(state, LEGACY_OPERATOR_SEED);
if (migratedLegacyJobs) save();

let idOwnsKami;
let roomComponent;
let moveSystem;
let sendSystem;
let marketAccID;

function authorizedReservationRequest(header) {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(RESERVATION_TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readReservationBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 16_384) throw new Error("reservation body too large");
  }
  return JSON.parse(body || "{}");
}

function writeJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function startReservationServer() {
  const server = createServer(async (request, response) => {
    try {
      if (
        request.method !== "POST"
          || (request.url !== "/v1/operator-reservations"
            && request.url !== "/v1/operator-reservations/attest")
      ) {
        writeJson(response, 404, { error: "not found" });
        return;
      }
      if (!authorizedReservationRequest(request.headers.authorization)) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      const body = await readReservationBody(request);
      if (String(body.market).toLowerCase() !== MARKET.toLowerCase() || String(body.factory).toLowerCase() !== FACTORY.toLowerCase()) {
        writeJson(response, 400, { error: "wrong market or factory" });
        return;
      }
      if (request.url === "/v1/operator-reservations") {
        const reservation = reserveRandomOperator(state, String(body.nonce));
        save();
        writeJson(response, 201, { operator: reservation.operator });
        return;
      }

      const quote = body.quote;
      const nonce = String(quote?.nonce ?? "").toLowerCase();
      const reservation = state.reservations?.[nonce];
      if (!quote || !reservation) {
        throw new Error("operator attestation does not match a live reservation");
      }
      const digest = await factory.quoteDigest(quote);
      bindOperatorReservationQuote(state, nonce, quote.operator, digest);
      save();
      const signature = keeper.signingKey.sign(digest).serialized;
      writeJson(response, 200, { keeperSignature: signature });
    } catch (error) {
      console.error("operator reservation failed:", error instanceof Error ? error.message : error);
      writeJson(response, 400, { error: "operator reservation failed" });
    }
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 6_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(RESERVATION_PORT, RESERVATION_HOST, () => resolve(server));
  });
}

async function registryAddress(registry, name) {
  const rows = await registry.getEntitiesWithValue(BigInt(keccakId(name)));
  if (!rows.length) throw new Error(`registry entry missing: ${name}`);
  return `0x${rows[0].toString(16).padStart(40, "0")}`;
}

async function wire() {
  const [componentsAddress, systemsAddress, onChainKeeper] = await Promise.all([
    world.components(),
    world.systems(),
    factory.keeper(),
  ]);
  if (String(onChainKeeper).toLowerCase() !== keeper.address.toLowerCase()) {
    throw new Error(`KEEPER_PRIVATE_KEY is not factory keeper ${onChainKeeper}`);
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
    const eventNonce = String(args.nonce);
    const existing = state.jobs[tokenIndex];
    if (!existing || String(existing.nonce).toLowerCase() !== eventNonce.toLowerCase()) {
      if (existing && !existing.returned) {
        throw new Error(`received a second active RoomPod event for Kami #${tokenIndex}`);
      }
      state.jobs[tokenIndex] = {
        tokenIndex,
        renter: String(args.renter),
        node: Number(args.nodeIndex),
        pod: String(args.pod),
        operator: String(args.operator),
        operatorKey: claimOperatorReservation(state, eventNonce, String(args.operator)),
        nonce: eventNonce,
        creds: null,
        strategyStarted: false,
        finalized: false,
        returned: false,
        eventBlock: event.blockNumber,
      };
    }
  }
  state.lastBlock = latest + 1;
  // Events are ingested before cleanup, so a valid on-chain request always
  // claims its key even if the worker was offline past the quote deadline.
  removeExpiredUnclaimedReservations(state);
  save();
}

async function ensureOperatorGas(tokenIndex, request, operator) {
  const [balance, feeData] = await Promise.all([
    provider.getBalance(operator.address),
    provider.getFeeData(),
  ]);
  if (feeData.gasPrice == null) {
    throw new Error(`operator gas health failed for Kami #${tokenIndex}: RPC returned no gas price`);
  }
  // One operating action costs ~1,611,833 gas, and the bot averages ~2 tx per
  // 439-minute cycle (~6.6 tx/day). The old fixed 1e12-wei reserve bought a
  // quarter of one action at 2.5 Mwei. Price the one-day reserve dynamically
  // so an RPC gas-price change cannot turn a previously safe constant into
  // another underfunded valve.
  const minimumActionWei = feeData.gasPrice * OPERATOR_ACTION_GAS_FLOOR;
  const reserve = feeData.gasPrice * OPERATOR_RESERVE_GAS_UNITS;
  const health = operatorGasHealth(balance, request.gasBudget, reserve, minimumActionWei);
  if (!health.canAffordAction) {
    throw new Error(
      `operator gas health failed for Kami #${tokenIndex}: ${operator.address} has ${balance} wei, `
        + `${request.gasBudget} wei escrow remains, projected ${health.projectedBalance} wei is `
        + `${health.shortfall} wei short of one action (${minimumActionWei} wei)`
    );
  }
  if (health.topUpAmount === 0n) return;

  await (await factory.connect(operator).pullGas(tokenIndex, health.topUpAmount)).wait();
  const fundedBalance = await provider.getBalance(operator.address);
  if (fundedBalance < minimumActionWei) {
    throw new Error(
      `operator gas health failed after top-up for Kami #${tokenIndex}: ${operator.address} has `
        + `${fundedBalance} wei but one action requires ${minimumActionWei} wei`
    );
  }
}

async function returnUnusedOperatorGas(tokenIndex, operator) {
  const balance = await provider.getBalance(operator.address);
  if (balance === 0n) return;

  const gasPrice = (await provider.getFeeData()).gasPrice;
  if (gasPrice == null) throw new Error("could not price the terminal operator gas return");

  const connected = factory.connect(operator);
  // Estimate the storage-changing path even when the factory budget is zero.
  const gasLimit = await connected.returnGas.estimateGas(tokenIndex, { value: 1n });
  const amount = operatorGasReturnAmount(balance, gasLimit, gasPrice);
  if (amount === 0n) return;

  // A legacy-priced transaction makes its maximum cost exact on Yominet. The
  // value can therefore return the rest of the ephemeral EOA's balance before
  // its key is erased; the factory includes it in the renter's final refund.
  await (
    await connected.returnGas(tokenIndex, {
      value: amount,
      gasLimit,
      gasPrice,
      type: 0,
    })
  ).wait();
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
  const operator = operatorWalletForJob(job, provider);
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
    await (await factory.connect(keeper).markLeasePreparing(job.tokenIndex)).wait();
    return;
  }

  if (stage === 2) {
    if (actualAccID === marketAccID) {
      await (await factory.connect(keeper).routePreparedKami(job.tokenIndex)).wait();
      return;
    }
    if (actualAccID !== podAccID) return;
    await ensureOperatorGas(job.tokenIndex, request, operator);
    await reconcileStrategy(job);
    await (await factory.connect(keeper).activateProvisionedLease(job.tokenIndex)).wait();
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
      await (await factory.connect(keeper).recoverPreparingFromHub(job.tokenIndex)).wait();
      return;
    }
    if (actualAccID === BigInt(listing.owner)) {
      await returnUnusedOperatorGas(job.tokenIndex, operator);
      await (await factory.connect(operator).finalizePreparingCancellation(job.tokenIndex)).wait();
      job.returned = true;
      purgeReturnedJobSecrets(job);
      save();
    }
    return;
  }

  if (stage === 5) {
    await stopStrategy(job);
    if (actualAccID === podAccID) {
      await (await sendSystem.connect(operator).executeTyped(job.tokenIndex, listing.owner)).wait();
      return;
    }
    if (actualAccID === BigInt(listing.owner)) {
      await returnUnusedOperatorGas(job.tokenIndex, operator);
      await (await factory.connect(keeper).finalizeGasRefund(job.tokenIndex)).wait();
      job.returned = true;
      purgeReturnedJobSecrets(job);
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
    purgeReturnedJobSecrets(job);
    save();
  }
}

async function tick() {
  await ingestEvents();
  for (const job of Object.values(state.jobs)) {
    if (job.returned) continue;
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
await startReservationServer();
console.log(`operator reservations listening on http://${RESERVATION_HOST}:${RESERVATION_PORT}`);
console.log(`renter-funded worker ready: market ${MARKET}, factory ${FACTORY}, keeper ${keeper.address}`);
for (;;) {
  const started = Date.now();
  await tick().catch((error) => console.error("tick failed:", error.message || error));
  await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, POLL_MS - (Date.now() - started))));
}
