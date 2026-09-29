#!/usr/bin/env node
/**
 * v15 renter-funded RoomPod worker.
 *
 * The renter's factory transaction already deployed the pod and funded every
 * automation wallet. This worker contributes no ETH and has no admin path. It
 * only advances the factory's constrained state machine:
 *   register Kamibots -> walk pod -> owner pool to hub -> hub to pod ->
 *   start Kamibots -> prove HARVESTING -> activate paid clock ->
 *   stop/sweep/finalize -> owner pool.
 *
 * Required env:
 *   YOMINET_RPC, WORLD_ADDR, MARKET_ADDRESS, RENTER_POD_FACTORY
 *   KEEPER_PRIVATE_KEY        (must equal the factory's immutable keeper)
 *   OPERATOR_RESERVATION_TOKEN (shared only with the quote API, 32+ chars)
 * Optional: LEGACY_PROVISIONING_OPERATOR_SEED (migration only),
 *   OPERATOR_RESERVATION_HOST, OPERATOR_RESERVATION_PORT,
 *   KAMIBOTS_API, KAMISTATS_URL, POLL_MS, START_BLOCK, WORKER_STATE_FILE,
 *   EVENT_CONFIRMATIONS (default 12; confirmed blocks only)
 * Launch hardening (see renter-pod-config.mjs for defaults):
 *   RENTER_ALLOWLIST, MAX_ACTIVE_LEASES, MAX_LIVE_RESERVATIONS,
 *   MAX_RESERVATIONS_PER_RENTER, RESERVATION_TTL_SEC, TX_WAIT_TIMEOUT_MS,
 *   FETCH_TIMEOUT_MS, TICK_WATCHDOG_SEC, HEARTBEAT_STALE_SEC,
 *   ALERT_MIN_INTERVAL_SEC, STAGE_STUCK_ALERT_SEC,
 *   RESERVATION_STATE_FILE (default <state>.reservations.json next to the
 *   state file), WORKER_HALT_FILE (default HALT next to the state file; while
 *   it exists the reservation server answers 503).
 * Lease safety (THR-02/03/10; defaults in renter-pod-config.mjs):
 *   PREFS_FLOOR, PREFS_FLOOR_HP_LOW_MIN, PREFS_FLOOR_FARM_INTERVAL_MAX_SEC,
 *   PREFS_FLOOR_SAFETY_MARGIN_MIN, PREFS_FLOOR_FEED_PERCENT_MIN,
 *   EXIT_RESERVE_ACTIONS, EXIT_RESUME_HEADROOM_ACTIONS, PREFS_CADENCE_GUARD,
 *   STRATEGY_RESTART_MIN_INTERVAL_SEC, KAMIBOTS_STOP_MAX_FAILURES,
 *   KAMIBOTS_RETRY_MAX_SEC.
 * Alerts needing a human are single lines starting with "[LEASE-ALERT] ".
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Contract,
  FetchRequest,
  JsonRpcProvider,
  Wallet,
  id as keccakId,
  solidityPackedKeccak256,
} from "ethers";
import { LeaseAlertCode, createLeaseAlerter } from "./renter-pod-alerts.mjs";
import { hardeningConfigFromEnv } from "./renter-pod-config.mjs";
import {
  RetiredJobAction,
  ingestRenterPodRecords,
  protectedReservationNonces,
  renterPodEventRecord,
  requestBelongsToOtherPod,
  retiredJobAction,
} from "./renter-pod-ingest.mjs";
import {
  buildHeartbeat,
  createTickWatchdog,
  fetchWithTimeout,
  heartbeatPathFor,
  reservationServiceHealth,
  writeJsonAtomic,
} from "./renter-pod-liveness.mjs";
import { createReservationHandler } from "./renter-pod-reservation-server.mjs";
import {
  activeJobCount,
  pruneReservations,
  reservationFileFor,
  reservationStats,
} from "./renter-pod-reservations.mjs";
import { loadWorkerState } from "./renter-pod-state.mjs";
import { runWorkerTick, txKeyForJob } from "./renter-pod-tick.mjs";
import { createTxTracker } from "./renter-pod-tx.mjs";
import {
  buildKamibotsStartBody,
  normalizeKamibotsPrefs,
} from "./kamibots-rental-config.mjs";
import { advanceActiveLease } from "./renter-pod-active.mjs";
import { observeKamiState } from "./renter-pod-safety.mjs";
import { createStrategyController } from "./renter-pod-strategy.mjs";
import {
  assertCanonicalCheckpoint,
  assertCursorSequence,
  checkpointForBlock,
} from "./renter-pod-events.mjs";
import {
  StageZeroAction,
  TerminalGasPullMode,
  TerminalGasReturnMode,
  operatorGasHealth,
  operatorGasReturnAmount,
  stageZeroAction,
  terminalGasReturnMode,
  terminalGasPullMode,
} from "./renter-pod-recovery.mjs";
import { advanceEndingLease } from "./renter-pod-ending.mjs";
import { advancePreparingLease } from "./renter-pod-activation.mjs";
import { operatorWalletForJob, purgeReturnedJobSecrets } from "./renter-pod-keys.mjs";

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
const EVENT_CONFIRMATIONS = Number(process.env.EVENT_CONFIRMATIONS || 12);
if (!Number.isSafeInteger(EVENT_CONFIRMATIONS) || EVENT_CONFIRMATIONS < 1 || EVENT_CONFIRMATIONS > 256) {
  throw new Error("EVENT_CONFIRMATIONS must be an integer between 1 and 256");
}
const TERMINAL_GAS_RETURN_MODE = terminalGasReturnMode(
  process.env.TERMINAL_GAS_RETURN_MODE
);
const TERMINAL_GAS_PULL_MODE = terminalGasPullMode(
  process.env.TERMINAL_GAS_PULL_MODE
);
const RESERVATION_HOST = process.env.OPERATOR_RESERVATION_HOST || "127.0.0.1";
const RESERVATION_PORT = Number(process.env.OPERATOR_RESERVATION_PORT || 8789);
const HARDENING = hardeningConfigFromEnv(process.env);
const RESERVATION_FILE = process.env.RESERVATION_STATE_FILE || reservationFileFor(STATE_FILE);
const HEARTBEAT_FILE = heartbeatPathFor(STATE_FILE);
const HALT_FILE = process.env.WORKER_HALT_FILE || join(dirname(STATE_FILE), "HALT");

const leaseAlert = createLeaseAlerter({ minIntervalMs: HARDENING.alertMinIntervalMs });

// Every JSON-RPC call gets a hard deadline (ethers' default is 5 minutes).
const rpcRequest = new FetchRequest(RPC);
rpcRequest.timeout = HARDENING.fetchTimeoutMs;
const provider = new JsonRpcProvider(rpcRequest);
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
// Job state (custody, cursor) and reservations (operator keys for quotes in
// flight) are separate atomic files: a quote request rewrites only the small
// reservation file. Legacy state files that embed reservations are migrated:
// the store is written first, then the state file without them.
const { state, save, saveReservations } = loadWorkerState({
  stateFile: STATE_FILE,
  reservationFile: RESERVATION_FILE,
  startBlock: process.env.START_BLOCK,
  legacySeed: LEGACY_OPERATOR_SEED,
});

const txs = createTxTracker({
  state,
  provider,
  timeoutMs: HARDENING.txWaitTimeoutMs,
  alert: leaseAlert,
  persist: save,
});
/** Send one job-scoped tx with a bounded wait (see renter-pod-tx.mjs). */
const sendTx = (job, label, sendFn) => txs.send(txKeyForJob(job), label, sendFn);

let lastIngestOkAt = null;
let lastHeartbeat = null;

let idOwnsKami;
let kamiStateComponent;
let roomComponent;
let harvestStopSystem;
let moveSystem;
let sendSystem;
let marketAccID;

function reservationHealth() {
  let halted = false;
  try {
    halted = existsSync(HALT_FILE);
  } catch {
    halted = true;
  }
  return reservationServiceHealth({
    nowMs: Date.now(),
    heartbeat: lastHeartbeat,
    lastIngestOkAtMs: lastIngestOkAt,
    staleMs: HARDENING.heartbeatStaleMs,
    halted,
  });
}

function startReservationServer() {
  const server = createServer(
    createReservationHandler({
      state,
      token: RESERVATION_TOKEN,
      market: MARKET,
      factory: FACTORY,
      policy: HARDENING,
      health: reservationHealth,
      quoteDigest: (quote) => factory.quoteDigest(quote),
      signDigest: (digest) => keeper.signingKey.sign(digest).serialized,
      saveReservations,
      alert: leaseAlert,
    })
  );
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
  kamiStateComponent = new Contract(
    await registryAddress(components, "component.state"),
    ["function get(uint256) view returns (string)"],
    provider
  );
  roomComponent = new Contract(
    await registryAddress(components, "component.index.room"),
    ["function get(uint256) view returns (uint32)"],
    provider
  );
  harvestStopSystem = new Contract(
    await registryAddress(systems, "system.harvest.stop"),
    ["function executeTyped(uint256) returns (bytes)"],
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
  const response = await fetchWithTimeout(`${KAMIBOTS}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "X-Agent-Key": apiKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }, { timeoutMs: HARDENING.fetchTimeoutMs });
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
  const response = await fetchWithTimeout(
    `${KAMISTATS}/api/vault/lease-tiles?market=${MARKET}`,
    {},
    { timeoutMs: HARDENING.fetchTimeoutMs }
  );
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
    await sendTx(job, `move:${room}`, () => moveSystem.connect(operator).executeTyped(Number(room)));
    current = Number(await roomComponent.get(accID));
    if (current !== Number(room)) throw new Error(`walk expected room ${room}, got ${current}`);
  }
  if (current !== Number(job.tile.room)) throw new Error(`pod stopped in room ${current}`);
}

async function applyIngest(records) {
  return ingestRenterPodRecords(state, records, {
    readRequestPod: async (tokenIndex) => (await factory.requests(tokenIndex)).pod,
    nowMs: Date.now(),
    alert: leaseAlert,
    log: (line) => console.error(line),
  });
}

/** Delete claimed reservations only after the jobs holding their keys are durable. */
function releaseClaimedReservations(claimedNonces) {
  if (!claimedNonces.length) return;
  for (const nonce of claimedNonces) delete state.reservations[nonce];
  saveReservations();
}

async function ingestEvents() {
  const latest = await provider.getBlockNumber();
  assertCursorSequence(state.lastBlock, state.eventCursor);
  if (state.eventCursor) {
    const canonicalCheckpoint = await provider.getBlock(state.eventCursor.blockNumber);
    assertCanonicalCheckpoint(state.eventCursor, canonicalCheckpoint);
  }

  // Do not consume tip events: advancing the durable cursor past a block that
  // is later reorganized can permanently miss its canonical replacement.
  const confirmedTip = latest - EVENT_CONFIRMATIONS;
  if (confirmedTip < 0) return;
  if (!state.lastBlock) state.lastBlock = Math.max(0, confirmedTip - 2_000);
  if (state.lastBlock > confirmedTip) {
    // No new confirmed range: still retry parked events.
    if (Object.keys(state.ingestRetry).length) {
      const { claimedNonces } = await applyIngest([]);
      save();
      releaseClaimedReservations(claimedNonces);
    }
    lastIngestOkAt = Date.now();
    return;
  }
  const confirmedBlockBefore = await provider.getBlock(confirmedTip);
  if (!confirmedBlockBefore) throw new Error(`confirmed block ${confirmedTip} is unavailable`);
  const nextCursor = checkpointForBlock(confirmedBlockBefore);
  const events = await factory.queryFilter(
    factory.filters.RenterPodCreated(),
    state.lastBlock,
    confirmedTip
  );
  // If the query raced a reorg, discard all in-memory results before claiming
  // a reservation or changing any durable job state.
  const confirmedBlockAfter = await provider.getBlock(confirmedTip);
  assertCanonicalCheckpoint(nextCursor, confirmedBlockAfter);
  const records = events.map(renterPodEventRecord);

  // Per-event isolation (THR-01): an event that cannot be applied is parked in
  // state.ingestRetry with an INGEST_ERROR alert; it never blocks the cursor
  // or any other token. The parked record is saved together with the cursor.
  const { claimedNonces } = await applyIngest(records);
  state.lastBlock = confirmedTip + 1;
  state.eventCursor = nextCursor;
  // Block time of the ingested tip: the reservation pruner uses it to prove a
  // signed quote's deadline has passed on-chain before dropping its key.
  const tipTime = Number(confirmedBlockBefore.timestamp);
  if (Number.isFinite(tipTime) && tipTime > 0) state.ingestedThroughSec = tipTime;
  save();
  releaseClaimedReservations(claimedNonces);
  lastIngestOkAt = Date.now();
}

async function ensureOperatorGas(job, request, operator, { allowPull = true, required = true } = {}) {
  const tokenIndex = job.tokenIndex;
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
  const health = operatorGasHealth(
    balance,
    allowPull ? request.gasBudget : 0n,
    reserve,
    minimumActionWei
  );
  if (!health.canAffordAction) {
    const detail =
      `operator gas health failed for Kami #${tokenIndex}: ${operator.address} has ${balance} wei, `
        + `${request.gasBudget} wei escrow remains, projected ${health.projectedBalance} wei is `
        + `${health.shortfall} wei short of one action (${minimumActionWei} wei)`
        + (allowPull ? "" : "; this deployed factory cannot pull escrow in a terminal stage");
    if (required) throw new Error(detail);
    // Advisory mode: the caller only has self-financing or keeper-signed work
    // left, so a broke operator must not wedge terminal cleanup. Kami #5846
    // proved the failure: 0.2e12 wei short of a 1.7M-gas "action" it never
    // needed, retried every tick for days while finalizeGasRefund - which the
    // KEEPER signs - waited behind the throw.
    console.warn(`${detail}; continuing - remaining terminal work does not need the operator`);
    return;
  }
  if (health.topUpAmount === 0n) return;

  await sendTx(job, "pullGas", () => factory.connect(operator).pullGas(tokenIndex, health.topUpAmount));
  const fundedBalance = await provider.getBalance(operator.address);
  if (fundedBalance < minimumActionWei) {
    throw new Error(
      `operator gas health failed after top-up for Kami #${tokenIndex}: ${operator.address} has `
        + `${fundedBalance} wei but one action requires ${minimumActionWei} wei`
    );
  }
}

async function returnUnusedOperatorGas(job, operator) {
  const tokenIndex = job.tokenIndex;
  if (TERMINAL_GAS_RETURN_MODE === TerminalGasReturnMode.SKIP) return;
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
  await sendTx(job, "returnGas", () =>
    connected.returnGas(tokenIndex, {
      value: amount,
      gasLimit,
      gasPrice,
      type: 0,
    })
  );
}

/** Raw Kamibots DELETE; 404 counts as stopped. Callers go through `strategy`. */
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

async function startStrategyRemote(job, prefs) {
  await kb("/api/strategies/start", {
    method: "POST",
    apiKey: job.creds.apiKey,
    body: buildKamibotsStartBody(
      { node: job.node, creds: job.creds },
      job.tokenIndex,
      prefs
    ),
  });
}

// THR-02 floor on every start and prefs update, THR-03 cadence guard,
// THR-10 restart debounce, Kamibots backoff and the on-chain stop fallback.
const strategy = createStrategyController({
  startRemote: startStrategyRemote,
  stopRemote: stopStrategy,
  readRawPrefs: (job) => factory.prefs(job.tokenIndex),
  normalize: normalizeJobPrefs,
  floor: HARDENING.prefsFloor,
  restartMinIntervalMs: HARDENING.strategyRestartMinIntervalMs,
  stopMaxFailures: HARDENING.kamibotsStopMaxFailures,
  retryMaxMs: HARDENING.kamibotsRetryMaxMs,
  cadenceGuard: HARDENING.cadenceGuard,
  market: MARKET,
  alert: leaseAlert,
  log: (line) => console.error(line),
  save: () => save(),
});

/** Record DEAD / not-DEAD for a job; true means "DEAD, skip Kami actions". */
function observeKami(job, kamiState, stage, action) {
  return observeKamiState(job, kamiState, {
    stage,
    action,
    market: MARKET,
    alert: leaseAlert,
    log: (line) => console.error(line),
  });
}

async function kamiIsDead(job, kamiID, stage, action) {
  return observeKami(job, await kamiStateComponent.get(kamiID), stage, action);
}

/** Operator balance, factory escrow and live gas price for the exit reserve. */
async function readOperatorGas(job, request, operator) {
  const [balance, feeData] = await Promise.all([
    provider.getBalance(operator.address),
    provider.getFeeData(),
  ]);
  if (feeData.gasPrice == null) {
    throw new Error(`operator gas health failed for Kami #${job.tokenIndex}: RPC returned no gas price`);
  }
  return { balance, escrow: BigInt(request.gasBudget), gasPrice: feeData.gasPrice };
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

  // THR-01: the factory's live request for this Kami belongs to a newer pod,
  // so this job's request was deleted (cancel/refund). Never drive the newer
  // request's stage machine with this job's pod and operator: only bring the
  // Kami home from THIS pod if it is somehow there, then retire.
  if (requestBelongsToOtherPod(job, request)) {
    await finishRetiredJob(job, { listing, podAccID, actualAccID, operator });
    return;
  }

  if (stage === 1) {
    if (!job.creds) {
      job.creds = await registerKamibots(operator);
      save();
    }
    await walk(job, operator, podAccID);
    await sendTx(job, "markLeasePreparing", () => factory.connect(keeper).markLeasePreparing(job.tokenIndex));
    return;
  }

  if (stage === 2) {
    if (actualAccID === marketAccID) {
      await sendTx(job, "routePreparedKami", () => factory.connect(keeper).routePreparedKami(job.tokenIndex));
      return;
    }
    if (actualAccID !== podAccID) return;
    if (await kamiIsDead(job, listing.kamiID, stage, "preparing")) {
      await strategy.stopForOnChain(job, { force: true });
      return;
    }
    await ensureOperatorGas(job, request, operator);
    await advancePreparingLease({
      reconcileStrategy: () => strategy.reconcile(job),
      readKamiState: () => kamiStateComponent.get(listing.kamiID),
      activateLease: async () => {
        await sendTx(job, "activateProvisionedLease", () =>
          factory.connect(keeper).activateProvisionedLease(job.tokenIndex)
        );
      },
    });
    return;
  }

  if (stage === 3) {
    const stopHarvest = async () => {
      const harvestID = solidityPackedKeccak256(
        ["string", "uint256"],
        ["harvest", listing.kamiID]
      );
      const connectedStop = harvestStopSystem.connect(operator);
      await connectedStop.executeTyped.staticCall(harvestID);
      await sendTx(job, "stopHarvest", () => connectedStop.executeTyped(harvestID));
    };
    // THR-03: the exit reserve is checked before the fail-closed gas check.
    await advanceActiveLease({
      job,
      nowSec: Math.floor(Date.now() / 1000),
      listing,
      market: MARKET,
      readGas: () => readOperatorGas(job, request, operator),
      actionGas: OPERATOR_ACTION_GAS_FLOOR,
      exitReserveActions: HARDENING.exitReserveActions,
      resumeHeadroomActions: HARDENING.exitResumeHeadroomActions,
      ensureGas: ({ required }) => ensureOperatorGas(job, request, operator, { required }),
      strategy,
      readKamiState: () => kamiStateComponent.get(listing.kamiID),
      stopHarvest,
      endLease: () => sendTx(job, "endLease", () => market.connect(operator).endLease(job.tokenIndex)),
      advanceEnding: () =>
        advanceEndingLease({
          tokenIndex: job.tokenIndex,
          // THR-10: a Kamibots outage cannot hold the on-chain stop hostage.
          stopStrategy: () => strategy.stopForOnChain(job),
          readKamiState: async () => {
            const kamiState = await kamiStateComponent.get(listing.kamiID);
            observeKami(job, kamiState, stage, "ending");
            return kamiState;
          },
          onDead: async () => {},
          stopHarvest,
          finalizeLease: async () => {
            await sendTx(job, "finalizeMarketLease", () => factory.connect(operator).finalizeMarketLease(job.tokenIndex));
          },
          markFinalized: async () => {
            job.finalized = true;
            save();
          },
        }),
      observeKami: (kamiState, action) => observeKami(job, kamiState, stage, action),
      alert: leaseAlert,
      log: (line) => console.error(line),
      save,
    });
    return;
  }

  if (stage === 4) {
    await strategy.stopForOnChain(job);
    if (actualAccID === podAccID) {
      // KamiSend needs RESTING/LISTED: a DEAD Kami would revert every tick.
      if (await kamiIsDead(job, listing.kamiID, stage, "kamiSend")) return;
      await ensureOperatorGas(job, request, operator, {
        allowPull: TERMINAL_GAS_PULL_MODE === TerminalGasPullMode.FACTORY,
      });
      await sendTx(job, "kamiSend", () => sendSystem.connect(operator).executeTyped(job.tokenIndex, listing.owner));
      return;
    }
    if (actualAccID === marketAccID) {
      await sendTx(job, "recoverPreparingFromHub", () => factory.connect(keeper).recoverPreparingFromHub(job.tokenIndex));
      return;
    }
    if (actualAccID === BigInt(listing.owner)) {
      if (TERMINAL_GAS_RETURN_MODE === TerminalGasReturnMode.FACTORY) {
        // Advisory only: returnUnusedOperatorGas prices its own transaction
        // against the real balance and skips when unaffordable, and the call
        // after it is keeper-signed. Requiring a full action here wedged
        // terminal cleanup on dust (see ensureOperatorGas).
        await ensureOperatorGas(job, request, operator, {
          allowPull: TERMINAL_GAS_PULL_MODE === TerminalGasPullMode.FACTORY,
          required: false,
        });
      }
      await returnUnusedOperatorGas(job, operator);
      // This factory entrypoint is permissionless. Use the durable keeper after
      // the ephemeral operator has returned its remaining balance.
      await sendTx(job, "finalizePreparingCancellation", () =>
        factory.connect(keeper).finalizePreparingCancellation(job.tokenIndex)
      );
      job.returned = true;
      purgeReturnedJobSecrets(job);
      save();
    }
    return;
  }

  if (stage === 5) {
    await strategy.stopForOnChain(job);
    if (actualAccID === podAccID) {
      if (await kamiIsDead(job, listing.kamiID, stage, "kamiSend")) return;
      await ensureOperatorGas(job, request, operator, {
        allowPull: TERMINAL_GAS_PULL_MODE === TerminalGasPullMode.FACTORY,
      });
      await sendTx(job, "kamiSend", () => sendSystem.connect(operator).executeTyped(job.tokenIndex, listing.owner));
      return;
    }
    if (actualAccID === BigInt(listing.owner)) {
      if (TERMINAL_GAS_RETURN_MODE === TerminalGasReturnMode.FACTORY) {
        // Advisory only: returnUnusedOperatorGas prices its own transaction
        // against the real balance and skips when unaffordable, and the call
        // after it is keeper-signed. Requiring a full action here wedged
        // terminal cleanup on dust (see ensureOperatorGas).
        await ensureOperatorGas(job, request, operator, {
          allowPull: TERMINAL_GAS_PULL_MODE === TerminalGasPullMode.FACTORY,
          required: false,
        });
      }
      await returnUnusedOperatorGas(job, operator);
      await sendTx(job, "finalizeGasRefund", () => factory.connect(keeper).finalizeGasRefund(job.tokenIndex));
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
      await strategy.stopForOnChain(job);
      if (await kamiIsDead(job, listing.kamiID, stage, "kamiSend")) {
        save();
        return;
      }
      await ensureOperatorGas(job, request, operator, { allowPull: false });
      await sendTx(job, "kamiSend", () => sendSystem.connect(operator).executeTyped(job.tokenIndex, listing.owner));
      save();
      return;
    }
    if (action === StageZeroAction.CLEAR_OWNER_RETURN) {
      await sendTx(job, "clearReturned", () => market.connect(operator).clearReturned(job.tokenIndex));
    } else if (action === StageZeroAction.CONFIRM_POOL_RETURN) {
      await sendTx(job, "confirmReturnedToPool", () => market.connect(operator).confirmReturnedToPool(job.tokenIndex));
    } else if (action === StageZeroAction.WAIT) {
      save();
      return;
    }
    job.returned = true;
    purgeReturnedJobSecrets(job);
    save();
  }
}

/**
 * Retired job (superseded pod for a Kami that has a newer request): stop its
 * Kamibots strategy, return the Kami if it is still in this job's pod, then
 * mark it returned. Market flags belong to the live job and are not touched.
 */
async function finishRetiredJob(job, { listing, podAccID, actualAccID, operator }) {
  await strategy.stopForOnChain(job);
  const action = retiredJobAction({ actualAccID, podAccID });
  if (action === RetiredJobAction.RETURN_FROM_POD) {
    if (await kamiIsDead(job, listing.kamiID, "retired", "kamiSend(retired)")) return;
    await ensureOperatorGas(job, { gasBudget: 0n }, operator, { allowPull: false });
    await sendTx(job, "kamiSend(retired)", () =>
      sendSystem.connect(operator).executeTyped(job.tokenIndex, listing.owner)
    );
    save();
    return;
  }
  job.finalized = true;
  job.returned = true;
  purgeReturnedJobSecrets(job);
  save();
  console.log(`#${job.tokenIndex}: retired superseded pod ${job.pod}`);
}

async function processRetiredJob(job) {
  const pod = new Contract(job.pod, POD_ABI, provider);
  const [listing, podAccID] = await Promise.all([market.listings(job.tokenIndex), pod.accID()]);
  const actualAccID = await idOwnsKami.safeGet(listing.kamiID);
  const needsOperator = retiredJobAction({ actualAccID, podAccID }) === RetiredJobAction.RETURN_FROM_POD;
  const operator = needsOperator ? operatorWalletForJob(job, provider) : null;
  await finishRetiredJob(job, { listing, podAccID, actualAccID, operator });
}

function pruneExpiredReservations() {
  const removed = pruneReservations(state, {
    nowMs: Date.now(),
    ttlMs: HARDENING.reservationTtlMs,
    ingestedThroughSec: state.ingestedThroughSec,
    protectedNonces: protectedReservationNonces(state),
  });
  if (removed) saveReservations();
  return removed;
}

function writeHeartbeat({ tickMs, lastTickOk }) {
  const heartbeat = buildHeartbeat({
    nowMs: Date.now(),
    lastBlock: state.lastBlock,
    lastTickOk,
    activeJobs: activeJobCount(state),
    liveReservations: reservationStats(state, {
      nowMs: Date.now(),
      ttlMs: HARDENING.reservationTtlMs,
    }).live,
    tickMs,
  });
  writeJsonAtomic(HEARTBEAT_FILE, heartbeat, { mode: 0o644, pretty: false });
  lastHeartbeat = heartbeat;
}

async function tick() {
  const result = await runWorkerTick({
    state,
    ingest: ingestEvents,
    prune: pruneExpiredReservations,
    processJob,
    processRetiredJob,
    txs,
    alert: leaseAlert,
    log: (line) => console.error(line),
    stageStuckAlertMs: HARDENING.stageStuckAlertMs,
    save,
  });
  // Only a tick that ran to completion refreshes the heartbeat.
  writeHeartbeat({ tickMs: result.tickMs, lastTickOk: result.ingestOk });
}

// A hung await (dropped tx, stalled RPC/Kamibots socket) keeps systemd's unit
// "active" while nothing advances. Exit so Restart=always brings up a fresh
// process; pending txs are persisted in the state file, so the restart never
// double-sends them.
const watchdog = createTickWatchdog({
  limitMs: HARDENING.tickWatchdogMs,
  onStall: ({ elapsedMs, limitMs }) => {
    leaseAlert(LeaseAlertCode.WORKER_STALL, {
      market: MARKET,
      tickSec: Math.floor(elapsedMs / 1000),
      limitSec: Math.floor(limitMs / 1000),
      lastBlock: state.lastBlock,
      action: "exit-for-restart",
    });
    process.exit(1);
  },
});
setInterval(() => watchdog.check(), Math.min(10_000, Math.max(1_000, Math.floor(HARDENING.tickWatchdogMs / 4)))).unref();

watchdog.begin();
await wire();
watchdog.end();
await startReservationServer();
console.log(`operator reservations listening on http://${RESERVATION_HOST}:${RESERVATION_PORT}`);
console.log(
  `renter-funded worker ready: market ${MARKET}, factory ${FACTORY}, keeper ${keeper.address}, `
    + `terminalGasReturn=${TERMINAL_GAS_RETURN_MODE}, terminalGasPull=${TERMINAL_GAS_PULL_MODE}`
);
console.log(
  `launch guards: allowlist=${HARDENING.renterAllowlist ? `${HARDENING.renterAllowlist.size} renters` : "off"}, `
    + `maxActiveLeases=${HARDENING.maxActiveLeases}, maxLiveReservations=${HARDENING.maxLiveReservations}, `
    + `maxReservationsPerRenter=${HARDENING.maxReservationsPerRenter}, `
    + `reservationTtlSec=${HARDENING.reservationTtlMs / 1000}, txWaitTimeoutMs=${HARDENING.txWaitTimeoutMs}, `
    + `fetchTimeoutMs=${HARDENING.fetchTimeoutMs}, tickWatchdogSec=${HARDENING.tickWatchdogMs / 1000}, `
    + `heartbeatStaleSec=${HARDENING.heartbeatStaleMs / 1000}, heartbeat=${HEARTBEAT_FILE}, `
    + `reservations=${RESERVATION_FILE}, haltFile=${HALT_FILE}`
);
const FLOOR = HARDENING.prefsFloor;
console.log(
  `lease safety: prefsFloor=${FLOOR ? `hpLow>=${FLOOR.hpThresholdLowMin},farm<=${FLOOR.farmIntervalMaxSec}s,`
    + `safetyMargin>=${FLOOR.safetyMarginMin},feed>=${FLOOR.feedPercentMin}%,no-${FLOOR.disallowedRisk}` : "off"}, `
    + `exitReserveActions=${HARDENING.exitReserveActions}, exitResumeHeadroomActions=${HARDENING.exitResumeHeadroomActions}, `
    + `cadenceGuard=${HARDENING.cadenceGuard ? "on" : "off"}, `
    + `strategyRestartMinIntervalSec=${HARDENING.strategyRestartMinIntervalMs / 1000}, `
    + `kamibotsStopMaxFailures=${HARDENING.kamibotsStopMaxFailures}, kamibotsRetryMaxSec=${HARDENING.kamibotsRetryMaxMs / 1000}`
);
for (;;) {
  const started = Date.now();
  watchdog.begin();
  await tick().catch((error) => console.error("tick failed:", error.message || error));
  watchdog.end();
  await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, POLL_MS - (Date.now() - started))));
}
