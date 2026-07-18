#!/usr/bin/env node
/**
 * KamiLeaseMarket ops bot — v7 POD MODEL.
 *
 * Topology: one HUB account (the pool) + one parked RoomPod account per tile.
 * Accounts NEVER move rooms; kamis are KamiSent between accounts instead:
 *
 *   idle / returning  -> kami belongs in the HUB
 *   leased            -> kami belongs in the POD of the renter's chosen node
 *
 * Every tick runs a RECONCILER: desired location vs actual location, and issues
 * the operator-gated KamiSend to converge (post-send cooldowns just mean the
 * same move retries next tick). Strategies only ever run on a pod, only while
 * leased, with the renter's node + risk. Pool kamis are NEVER farmed.
 *
 * Also: auto-confirmArrival, pod MUSU sweeps to the hub, owner returns
 * (hub -> owner + clearReturned), and the THEFT ALARM (kami outside hub+pods
 * without a return request -> alert + optional rotate of ALL operators).
 *
 * Files: ./.env, ./pods.json (pod addresses + operator keys),
 * ./kamibots-credentials.json (hub), ./kamibots-credentials-pod<node>.json
 * (per-pod Kamibots registrations). State persists in ops-state.json.
 */
import { JsonRpcProvider, Wallet, Contract, id as keccakId } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

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
const SWEEP_MIN_MUSU = Number(process.env.SWEEP_MIN_MUSU || 100);

const STATE_FILE = new URL("./ops-state.json", import.meta.url).pathname;
const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { lastBlock: 0, strategies: {}, prefs: {} };
state.strategies ??= {}; // tokenIndex -> node the strategy runs on
state.prefs ??= {}; // tokenIndex -> latest prefs JSON string
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const loadJson = (rel) => {
  const p = new URL(rel, import.meta.url).pathname;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
const hubCreds = loadJson("./kamibots-credentials.json");
const podsFile = loadJson("./pods.json");
if (!podsFile?.pods?.length) throw new Error("pods.json missing — deploy pods first");

// ---- chain wiring -----------------------------------------------------------
const provider = new JsonRpcProvider(RPC);
const operator = new Wallet(OP_KEY, provider); // HUB operator
const admin = ADMIN_KEY ? new Wallet(ADMIN_KEY, provider) : null;

const MARKET_ABI = [
  "function accID() view returns (uint256)",
  "function numListings() view returns (uint256)",
  "function tokenIndices(uint256) view returns (uint32)",
  "function listings(uint32) view returns (address owner, uint256 kamiID, uint256 xpBase, uint16 ownerShareBps, uint128 minGasWei, bool staked, bool returning, address renter, uint256 gasBudget)",
  "function clearReturned(uint32 tokenIndex)",
  "function confirmArrival(uint32 tokenIndex)",
  "function rotateOperator(address newOperator)",
  "event LeaseAccepted(address indexed renter, uint32 indexed tokenIndex, uint256 gasBudget, string prefs)",
  "event LeaseEnded(uint32 indexed tokenIndex, address indexed renter, uint256 gasRefund)",
  "event ReturnRequested(address indexed owner, uint32 indexed tokenIndex)",
  "event PrefsUpdated(uint32 indexed tokenIndex, address indexed renter, string prefs)",
];
const POD_ABI = [
  "function accID() view returns (uint256)",
  "function nodeIndex() view returns (uint32)",
  "function musuBalance() view returns (uint256)",
  "function sweepMusu() returns (uint256)",
  "function rotateOperator(address newOperator)",
];
const market = new Contract(MARKET, MARKET_ABI, provider);

/** node -> { node, label, address, contract, wallet, accID, creds } */
const pods = new Map();
for (const p of podsFile.pods) {
  pods.set(Number(p.node), {
    node: Number(p.node),
    label: p.label,
    address: p.address,
    contract: new Contract(p.address, POD_ABI, provider),
    wallet: new Wallet(p.operatorKey, provider),
    accID: null,
    creds: loadJson(`./kamibots-credentials-pod${p.node}.json`),
  });
}
const DEFAULT_NODE = Number(process.env.DEFAULT_NODE_INDEX || [...pods.keys()][0]);

const world = new Contract(WORLD, ["function components() view returns (address)", "function systems() view returns (address)"], provider);
const REG_ABI = ["function getEntitiesWithValue(uint256 value) view returns (uint256[])"];
const COMP_ABI = [...REG_ABI, "function getValue(uint256 entity) view returns (uint256)"];

let comps, idOwnsKami, addrOperator, kamiSendAddr, marketAccID;
const KAMI_SEND_ABI = ["function executeTyped(uint32 kamiIndex, address toAddress) returns (bytes)"];

async function wire() {
  const [compsAddr, sysAddr] = await Promise.all([world.components(), world.systems()]);
  comps = new Contract(compsAddr, REG_ABI, provider);
  const systems = new Contract(sysAddr, REG_ABI, provider);
  const lookup = async (reg, idStr) => {
    const e = await reg.getEntitiesWithValue(BigInt(keccakId(idStr)));
    if (!e.length) throw new Error(`not found: ${idStr}`);
    return "0x" + e[0].toString(16).padStart(40, "0");
  };
  idOwnsKami = new Contract(await lookup(comps, "component.id.kami.owns"), COMP_ABI, provider);
  addrOperator = new Contract(await lookup(comps, "component.address.operator"), COMP_ABI, provider);
  kamiSendAddr = await lookup(systems, "system.kami.send");
  marketAccID = await market.accID();
  for (const pod of pods.values()) {
    pod.accID = await pod.contract.accID();
    // AUTO_REGISTER=1 (opt-in): the operator of this bot authorizes Kamibots
    // registration for any pod that lacks one — same flow as register-pods.sh
    if (!pod.creds && process.env.AUTO_REGISTER === "1") {
      try {
        console.log(`auto-registering pod ${pod.node} on Kamibots…`);
        execSync(`bash ./register-pods.sh ${pod.node}`, {
          cwd: dirname(fileURLToPath(import.meta.url)),
          stdio: "inherit",
        });
        pod.creds = loadJson(`./kamibots-credentials-pod${pod.node}.json`);
      } catch (e) {
        console.error(`auto-register pod ${pod.node} failed: ${e.message?.slice(0, 160)}`);
      }
    }
    console.log(`pod node ${pod.node} (${pod.label}) acc ${pod.accID} kamibots:${pod.creds ? "✓" : "✗ NOT REGISTERED"}`);
  }
  console.log(`wired. hub acc ${marketAccID}, ${pods.size} pods`);
}

const podByAccID = (acc) => [...pods.values()].find((p) => p.accID === acc) || null;
const kamiSendAs = (wallet) => new Contract(kamiSendAddr, KAMI_SEND_ABI, wallet);

// ---- kamibots (per-registration creds) --------------------------------------
async function kb(creds, path, opts = {}) {
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

function parsePrefs(idx) {
  let risk = "balanced";
  let node = DEFAULT_NODE;
  try {
    const p = JSON.parse(state.prefs[idx] || "{}");
    if (RISK[p.risk]) risk = p.risk;
    if (pods.has(Number(p.node))) node = Number(p.node);
  } catch {}
  return { risk, node };
}

const warnedPods = new Set();
async function startStrategy(pod, tokenIndex, risk) {
  if (!pod.creds) {
    if (!warnedPods.has(pod.node)) {
      warnedPods.add(pod.node);
      console.error(`⚠️  pod node ${pod.node} has NO Kamibots registration (kamibots-credentials-pod${pod.node}.json) — kami #${tokenIndex} is parked but NOT farming`);
    }
    return;
  }
  try {
    await kb(pod.creds, "/api/strategies/start", {
      method: "POST",
      body: {
        strategyType: "harvestAndRest",
        kamiId: tokenIndex,
        nodeId: pod.node,
        config: { farmInterval: 1800, restInterval: 1800, initialCooldown: 60, ...(RISK[risk] || RISK.balanced) },
        keyData: { privy_id: pod.creds.privyId },
      },
    });
    state.strategies[tokenIndex] = pod.node;
    console.log(`▶️  kami #${tokenIndex} farming node ${pod.node} (${risk}) via ${pod.label}`);
  } catch (e) {
    console.error(`strategy start failed #${tokenIndex} on pod ${pod.node}: ${e.message}`);
  }
}

async function stopStrategy(tokenIndex) {
  const node = state.strategies[tokenIndex];
  if (node === undefined) return;
  const pod = pods.get(Number(node));
  if (pod?.creds) {
    try {
      await kb(pod.creds, `/api/strategies/kami/${tokenIndex}`, {
        method: "DELETE",
        body: { keyData: { privy_id: pod.creds.privyId } },
      });
    } catch (e) {
      if (!/404/.test(e.message)) console.error(`strategy stop failed #${tokenIndex}: ${e.message}`);
    }
  }
  delete state.strategies[tokenIndex];
  console.log(`⏹️  strategy stopped for kami #${tokenIndex} (pod ${node})`);
}

// ---- the reconciler ---------------------------------------------------------
// desired location: leased -> renter's pod; otherwise -> hub. converge with
// operator-gated KamiSends; cooldown failures simply retry next tick.
async function reconcile(idx, l) {
  const actualAcc = await idOwnsKami.getValue(l.kamiID).catch(() => null);
  if (actualAcc === null) return;

  const { risk, node } = parsePrefs(idx);
  const leased = l.renter !== "0x0000000000000000000000000000000000000000";
  const targetPod = leased ? pods.get(node) : null;
  const desiredAcc = leased ? targetPod.accID : marketAccID;

  if (actualAcc === desiredAcc) {
    if (leased && state.strategies[idx] !== targetPod.node) {
      // arrived at the right tile: strategy should be running there
      if (state.strategies[idx] !== undefined) await stopStrategy(idx);
      await startStrategy(targetPod, idx, risk);
    }
    return;
  }

  // wrong place. never farm while relocating.
  if (state.strategies[idx] !== undefined) await stopStrategy(idx);

  // who currently holds it, and can we move it?
  let fromWallet = null;
  if (actualAcc === marketAccID) fromWallet = operator;
  else {
    const holdingPod = podByAccID(actualAcc);
    if (holdingPod) fromWallet = holdingPod.wallet;
  }
  if (!fromWallet) return; // outside hub+pods: arrival flow or theft alarm owns this

  const toAddr = leased ? targetPod.wallet.address : operator.address;
  try {
    const tx = await kamiSendAs(fromWallet).executeTyped(idx, toAddr);
    await tx.wait();
    console.log(`🚚 kami #${idx} shipped -> ${leased ? `pod ${targetPod.node} (${targetPod.label})` : "hub pool"} (${tx.hash})`);
  } catch (e) {
    const msg = e.message?.slice(0, 140) || "";
    if (!/cooldown|resting/i.test(msg)) console.error(`ship #${idx} failed: ${msg}`);
    // else: kami mid-rest or post-send cooldown — retry next tick
  }
}

// ---- return flow (kami must be in the HUB; reconciler brings it there) ------
async function sendKamiHome(idx, ownerAddr, kamiID) {
  const at = await idOwnsKami.getValue(kamiID).catch(() => null);
  if (at !== marketAccID) return; // still traveling pod -> hub; next tick
  const ownerOperator = await addrOperator.getValue(BigInt(ownerAddr)).catch(() => null);
  if (!ownerOperator) {
    console.error(`return #${idx}: owner has no operator on file — manual return needed`);
    return;
  }
  const opAddr = "0x" + BigInt(ownerOperator).toString(16).padStart(40, "0");
  try {
    const tx = await kamiSendAs(operator).executeTyped(idx, opAddr);
    await tx.wait();
    console.log(`🏠 kami #${idx} sent home to ${ownerAddr} (${tx.hash})`);
    const clear = await market.connect(operator).clearReturned(idx);
    await clear.wait();
    console.log(`✅ return finalized on-chain for #${idx}`);
  } catch (e) {
    console.error(`return send failed #${idx}: ${e.message?.slice(0, 160)} (cooldown? retrying next tick)`);
  }
}

// ---- pod sweeps -------------------------------------------------------------
async function sweepPods() {
  for (const pod of pods.values()) {
    try {
      const bal = await pod.contract.musuBalance();
      if (bal >= BigInt(SWEEP_MIN_MUSU)) {
        const tx = await pod.contract.connect(operator).sweepMusu();
        await tx.wait();
        console.log(`🧹 pod ${pod.node} swept ${bal} MUSU -> hub`);
      }
    } catch (e) {
      console.error(`sweep pod ${pod.node} failed: ${e.message?.slice(0, 120)}`);
    }
  }
}

// ---- theft alarm ------------------------------------------------------------
async function theftCheck() {
  const allowed = new Set([marketAccID, ...[...pods.values()].map((p) => p.accID)]);
  const n = Number(await market.numListings());
  for (let i = 0; i < n; i++) {
    const idx = Number(await market.tokenIndices(i));
    const l = await market.listings(idx);
    if (!l.staked || l.returning) continue;
    const at = await idOwnsKami.getValue(l.kamiID).catch(() => null);
    if (at === null || allowed.has(at)) continue;

    console.error(`🚨🚨 THEFT ALARM: listed kami #${idx} left the protocol (now in acc ${at}) WITHOUT a return request!`);
    writeFileSync(new URL("./THEFT-ALARM.txt", import.meta.url).pathname,
      `${new Date().toISOString()} kami #${idx} moved to acc ${at}\n`, { flag: "a" });
    if (admin) {
      // rotate EVERY operator — hub and pods — and cut all automation off
      const rotations = [["hub", (a) => market.connect(admin).rotateOperator(a)]];
      for (const pod of pods.values())
        rotations.push([`pod ${pod.node}`, (a) => pod.contract.connect(admin).rotateOperator(a)]);
      for (const [name, rotate] of rotations) {
        try {
          const fresh = Wallet.createRandom();
          console.error(`auto-rotating ${name} operator to ${fresh.address} (key printed ONCE): ${fresh.privateKey}`);
          const tx = await rotate(fresh.address);
          await tx.wait();
        } catch (e) {
          console.error(`rotate ${name} failed: ${e.message?.slice(0, 120)}`);
        }
      }
      console.error(`🔒 all operators rotated — automation cut off`);
    }
  }
}

// ---- main loop --------------------------------------------------------------
async function tick() {
  const head = await provider.getBlockNumber();
  const from = state.lastBlock ? state.lastBlock + 1 : Math.max(0, head - 5_000);

  const [accepted, ended, prefEvents] = await Promise.all([
    market.queryFilter(market.filters.LeaseAccepted(), from, head),
    market.queryFilter(market.filters.LeaseEnded(), from, head),
    market.queryFilter(market.filters.PrefsUpdated(), from, head),
  ]);
  for (const e of accepted) state.prefs[Number(e.args.tokenIndex)] = e.args.prefs || "";
  for (const e of prefEvents) state.prefs[Number(e.args.tokenIndex)] = e.args.prefs || "";
  for (const e of ended) {
    const idx = Number(e.args.tokenIndex);
    delete state.prefs[idx];
    await stopStrategy(idx); // fast stop; reconciler ships it back to the hub
  }

  const n = Number(await market.numListings());
  for (let i = 0; i < n; i++) {
    const idx = Number(await market.tokenIndices(i));
    const l = await market.listings(idx);

    // arrivals: listed-but-unpooled kami that landed in the hub joins the pool
    if (!l.staked) {
      const at = await idOwnsKami.getValue(l.kamiID).catch(() => null);
      if (at !== null && at === marketAccID) {
        try {
          const tx = await market.connect(operator).confirmArrival(idx);
          await tx.wait();
          console.log(`📬 kami #${idx} joined the pool`);
        } catch (e2) {
          console.error(`confirmArrival #${idx} failed: ${e2.message?.slice(0, 120)}`);
        }
      }
      continue;
    }

    if (l.returning) {
      if (state.strategies[idx] !== undefined) await stopStrategy(idx);
      await sendKamiHome(idx, l.owner, l.kamiID); // reconciler handles pod->hub leg
      const at = await idOwnsKami.getValue(l.kamiID).catch(() => null);
      if (at !== null && at !== marketAccID && podByAccID(at)) await reconcile(idx, { ...l, renter: "0x0000000000000000000000000000000000000000" });
      continue;
    }

    await reconcile(idx, l);
  }

  await sweepPods();
  await theftCheck();
  state.lastBlock = head;
  saveState();
}

await wire();
console.log(`ops-bot v7 online. hub ${MARKET}, hub operator ${operator.address}, pods [${[...pods.keys()].join(", ")}], admin ${admin ? "armed" : "not set"}`);
for (;;) {
  try { await tick(); } catch (e) { console.error(`tick error: ${e.message?.slice(0, 200)}`); }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
