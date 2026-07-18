#!/usr/bin/env node
/**
 * KamiLeaseMarket ops bot — the ONLY off-chain automation the market needs.
 * Everything user-facing is a dApp button; this covers the actions that require
 * the platform's keys:
 *
 *   1. LeaseAccepted / SendConfirmed  -> start a Kamibots strategy (risk-mapped)
 *   2. LeaseEnded                     -> stop the strategy
 *   3. ReturnRequested               -> stop strategy, operator-KamiSend the kami
 *                                       home, then clearReturned() on-chain
 *   4. THEFT ALARM: any listed kami that leaves the market account without a
 *      return request -> loud alert (+ optional auto-rotate if ADMIN key present)
 *
 * State (last processed block, active strategies) persists in ops-state.json.
 * Run: node ops-bot.mjs        (uses ./.env + ./kamibots-credentials.json)
 */
import { JsonRpcProvider, Wallet, Contract, id as keccakId } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---- env / config -----------------------------------------------------------
const envPath = new URL("./.env", import.meta.url).pathname;
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const RPC = process.env.YOMINET_RPC;
const WORLD = process.env.WORLD_ADDR;
const MARKET = process.env.MARKET_ADDRESS;
const OP_KEY = process.env.OPERATOR_PRIVATE_KEY;
const ADMIN_KEY = process.env.ADMIN_PRIVATE_KEY; // optional: enables auto-rotate on theft
const KAMIBOTS = process.env.KAMIBOTS_API || "https://api.kamibots.xyz";
const POLL_MS = 30_000;
const DEFAULT_NODE = Number(process.env.DEFAULT_NODE_INDEX || 1);

const STATE_FILE = new URL("./ops-state.json", import.meta.url).pathname;
const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { lastBlock: 0, strategies: {} }; // strategies: tokenIndex -> true
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const creds = existsSync(new URL("./kamibots-credentials.json", import.meta.url).pathname)
  ? JSON.parse(readFileSync(new URL("./kamibots-credentials.json", import.meta.url).pathname, "utf8"))
  : null;

// ---- chain wiring -----------------------------------------------------------
const provider = new JsonRpcProvider(RPC);
const operator = new Wallet(OP_KEY, provider);
const admin = ADMIN_KEY ? new Wallet(ADMIN_KEY, provider) : null;

const MARKET_ABI = [
  "function accID() view returns (uint256)",
  "function numListings() view returns (uint256)",
  "function tokenIndices(uint256) view returns (uint32)",
  "function listings(uint32) view returns (address owner, uint256 kamiID, uint256 xpBase, uint16 ownerShareBps, uint128 minGasWei, bool staked, bool returning, address renter, uint256 gasBudget)",
  "function clearReturned(uint32 tokenIndex)",
  "function rotateOperator(address newOperator)",
  "event LeaseAccepted(address indexed renter, uint32 indexed tokenIndex, uint256 gasBudget, string prefs)",
  "event LeaseEnded(uint32 indexed tokenIndex, address indexed renter, uint256 gasRefund)",
  "event SendConfirmed(address indexed owner, uint32 indexed tokenIndex)",
  "event ReturnRequested(address indexed owner, uint32 indexed tokenIndex)",
  "event PrefsUpdated(uint32 indexed tokenIndex, address indexed renter, string prefs)",
];
const market = new Contract(MARKET, MARKET_ABI, provider);

const world = new Contract(WORLD, ["function components() view returns (address)", "function systems() view returns (address)"], provider);
const REG_ABI = ["function getEntitiesWithValue(uint256 value) view returns (uint256[])"];
const COMP_ABI = [...REG_ABI, "function getValue(uint256 entity) view returns (uint256)"];

let comps, systems, idOwnsKami, addrOperator, kamiSendSystem, marketAccID;

async function wire() {
  const [compsAddr, sysAddr] = await Promise.all([world.components(), world.systems()]);
  comps = new Contract(compsAddr, REG_ABI, provider);
  systems = new Contract(sysAddr, REG_ABI, provider);
  const compAddr = async (idStr) => {
    const e = await comps.getEntitiesWithValue(BigInt(keccakId(idStr)));
    if (!e.length) throw new Error(`component not found: ${idStr}`);
    return "0x" + e[0].toString(16).padStart(40, "0");
  };
  const sysAddrOf = async (idStr) => {
    const e = await systems.getEntitiesWithValue(BigInt(keccakId(idStr)));
    if (!e.length) throw new Error(`system not found: ${idStr}`);
    return "0x" + e[0].toString(16).padStart(40, "0");
  };
  idOwnsKami = new Contract(await compAddr("component.id.kami.owns"), COMP_ABI, provider);
  addrOperator = new Contract(await compAddr("component.address.operator"), COMP_ABI, provider);
  kamiSendSystem = new Contract(
    await sysAddrOf("system.kami.send"),
    ["function executeTyped(uint32 kamiIndex, address toAddress) returns (bytes)"],
    operator
  );
  marketAccID = await market.accID();
  console.log(`wired. market acc ${marketAccID}`);
}

// ---- kamibots ---------------------------------------------------------------
async function kb(path, opts = {}) {
  if (!creds) throw new Error("no kamibots credentials");
  const res = await fetch(`${KAMIBOTS}${path}`, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json", "X-Agent-Key": creds.apiKey },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const RISK = {
  safe: { useHpBasedRest: true, hpThresholdLow: 50, hpThresholdHigh: 90 },
  balanced: { useHpBasedRest: true, hpThresholdLow: 30, hpThresholdHigh: 80 },
  aggressive: { useHpBasedRest: true, hpThresholdLow: 15, hpThresholdHigh: 60 },
};

async function startStrategy(tokenIndex, prefsJson) {
  let risk = "balanced";
  try { risk = JSON.parse(prefsJson || "{}").risk || "balanced"; } catch {}
  const cfg = RISK[risk] || RISK.balanced;
  try {
    await kb("/api/strategies/start", {
      method: "POST",
      body: {
        strategyType: "harvestAndRest",
        kamiId: tokenIndex,
        nodeId: DEFAULT_NODE,
        config: { farmInterval: 1800, restInterval: 1800, initialCooldown: 60, ...cfg },
        keyData: { privy_id: creds.privyId },
      },
    });
    state.strategies[tokenIndex] = true;
    console.log(`▶️  strategy started for kami #${tokenIndex} (${risk})`);
  } catch (e) {
    console.error(`strategy start failed #${tokenIndex}: ${e.message}`);
  }
}

async function stopStrategy(tokenIndex) {
  try {
    await kb(`/api/strategies/kami/${tokenIndex}`, {
      method: "DELETE",
      body: { keyData: { privy_id: creds.privyId } },
    });
  } catch (e) {
    if (!/404/.test(e.message)) console.error(`strategy stop failed #${tokenIndex}: ${e.message}`);
  }
  delete state.strategies[tokenIndex];
  console.log(`⏹️  strategy stopped for kami #${tokenIndex}`);
}

// ---- return flow ------------------------------------------------------------
async function sendKamiHome(tokenIndex, ownerAddr) {
  // KamiSend targets are resolved by the TARGET account's operator address
  const ownerAccID = BigInt(ownerAddr);
  const ownerOperator = await addrOperator.getValue(ownerAccID).catch(() => null);
  if (!ownerOperator) {
    console.error(`return #${tokenIndex}: owner has no operator on file — manual return needed`);
    return;
  }
  const opAddr = "0x" + BigInt(ownerOperator).toString(16).padStart(40, "0");
  try {
    const tx = await kamiSendSystem.executeTyped(tokenIndex, opAddr);
    await tx.wait();
    console.log(`🏠 kami #${tokenIndex} sent home to ${ownerAddr} (${tx.hash})`);
    const clear = await market.connect(operator).clearReturned(tokenIndex);
    await clear.wait();
    console.log(`✅ return finalized on-chain for #${tokenIndex}`);
  } catch (e) {
    console.error(`return send failed #${tokenIndex}: ${e.message?.slice(0, 200)} (cooldown? retrying next tick)`);
  }
}

// ---- theft alarm ------------------------------------------------------------
const returningSet = new Set();
async function theftCheck() {
  const n = Number(await market.numListings());
  for (let i = 0; i < n; i++) {
    const idx = Number(await market.tokenIndices(i));
    const l = await market.listings(idx);
    if (!l.staked || l.returning) continue;
    const kamis = await idOwnsKami.getValue(l.kamiID).catch(() => null);
    if (kamis === null) continue;
    if (kamis !== marketAccID) {
      console.error(`🚨🚨 THEFT ALARM: listed kami #${idx} left the market account WITHOUT a return request!`);
      writeFileSync(new URL("./THEFT-ALARM.txt", import.meta.url).pathname,
        `${new Date().toISOString()} kami #${idx} moved to acc ${kamis}\n`, { flag: "a" });
      if (admin) {
        const fresh = Wallet.createRandom();
        console.error(`auto-rotating operator to ${fresh.address} (key printed ONCE): ${fresh.privateKey}`);
        const tx = await market.connect(admin).rotateOperator(fresh.address);
        await tx.wait();
        console.error(`🔒 operator rotated — automation cut off`);
      }
    }
  }
}

// ---- main loop --------------------------------------------------------------
async function tick() {
  const head = await provider.getBlockNumber();
  const from = state.lastBlock ? state.lastBlock + 1 : Math.max(0, head - 5_000);

  const [accepted, ended, confirmed, returns_] = await Promise.all([
    market.queryFilter(market.filters.LeaseAccepted(), from, head),
    market.queryFilter(market.filters.LeaseEnded(), from, head),
    market.queryFilter(market.filters.SendConfirmed(), from, head),
    market.queryFilter(market.filters.ReturnRequested(), from, head),
  ]);

  for (const e of confirmed) {
    const idx = Number(e.args.tokenIndex);
    if (!state.strategies[idx]) await startStrategy(idx, ""); // platform farms unleased too
  }
  for (const e of accepted) {
    const idx = Number(e.args.tokenIndex);
    await stopStrategy(idx); // restart with the renter's prefs
    await startStrategy(idx, e.args.prefs);
  }
  for (const e of ended) await stopStrategy(Number(e.args.tokenIndex));
  for (const e of returns_) {
    const idx = Number(e.args.tokenIndex);
    returningSet.add(idx);
    await stopStrategy(idx);
    await sendKamiHome(idx, e.args.owner);
  }

  // retry unfinished returns (cooldown etc.)
  for (const idx of [...returningSet]) {
    const l = await market.listings(idx).catch(() => null);
    if (!l || !l.returning) { returningSet.delete(idx); continue; }
    await sendKamiHome(idx, l.owner);
  }

  await theftCheck();
  state.lastBlock = head;
  saveState();
}

await wire();
console.log(`ops-bot online. market ${MARKET}, operator ${operator.address}, admin ${admin ? "armed" : "not set"}`);
for (;;) {
  try { await tick(); } catch (e) { console.error(`tick error: ${e.message?.slice(0, 200)}`); }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
