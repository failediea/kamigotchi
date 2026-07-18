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
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
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
// after a lease ends the kami PARKS in its pod for this long — a re-rent on the
// same tile starts instantly (no KamiSend, no 1h in-game cooldown). only after
// the grace expires does it ship back to the hub pool.
const PARK_GRACE_MS = Number(process.env.PARK_GRACE_HOURS || 2) * 3600_000;

const STATE_FILE = new URL("./ops-state.json", import.meta.url).pathname;
const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { lastBlock: 0, strategies: {}, prefs: {} };
state.strategies ??= {}; // tokenIndex -> node:risk the strategy runs as
state.prefs ??= {}; // tokenIndex -> latest prefs JSON string
state.parkedAt ??= {}; // tokenIndex -> ms timestamp the pod-park grace started
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
  "function lastSettleAt() view returns (uint64)",
  "function settleCooldown() view returns (uint64)",
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
const GUARD_ABI = [
  "function ship(uint32 tokenIndex, address targetOperator)",
  "function keeperStop(uint32 tokenIndex)",
  "function harvestOf(uint32) view returns (uint256)",
];
const market = new Contract(MARKET, MARKET_ABI, provider);

/** BOT pods: node -> { kind:'bot', node, label, address, contract, wallet, accID, creds } */
const pods = new Map();
for (const p of podsFile.pods) {
  pods.set(Number(p.node), {
    kind: "bot",
    node: Number(p.node),
    label: p.label,
    address: p.address,
    contract: new Contract(p.address, POD_ABI, provider),
    wallet: new Wallet(p.operatorKey, provider),
    accID: null,
    creds: loadJson(`./kamibots-credentials-pod${p.node}.json`),
  });
}
/** SELF-FARM pods: node -> { kind:'self', ..., guard } — operator IS the guard
 *  contract; renters farm themselves; we only ship (keeper) and sweep. */
const selfPods = new Map();
for (const p of podsFile.selfPods || []) {
  selfPods.set(Number(p.node), {
    kind: "self",
    node: Number(p.node),
    label: p.label,
    address: p.address,
    guard: p.guard,
    contract: new Contract(p.address, POD_ABI, provider),
    guardContract: new Contract(p.guard, GUARD_ABI, provider),
    accID: null,
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
  // IDOwnsKamiComponent: use safeGet(uint256)->uint256 (like LibKami.getAccount).
  // getValue REVERTS on live Yominet; safeGet returns 0 for an unstaked kami.
  idOwnsKami = new Contract(
    await lookup(comps, "component.id.kami.owns"),
    ["function safeGet(uint256) view returns (uint256)"],
    provider
  );
  // AddressOperatorComponent: use get(uint256)->address. getValue REVERTS on live.
  addrOperator = new Contract(
    await lookup(comps, "component.address.operator"),
    ["function get(uint256) view returns (address)"],
    provider
  );
  kamiSendAddr = await lookup(systems, "system.kami.send");
  marketAccID = await market.accID();
  for (const pod of pods.values()) {
    pod.accID = await pod.contract.accID();
    await ensureRegistered(pod);
    console.log(`pod node ${pod.node} (${pod.label}) acc ${pod.accID} kamibots:${pod.creds ? "✓" : "✗ NOT REGISTERED"}`);
  }
  for (const sp of selfPods.values()) {
    sp.accID = await sp.contract.accID();
    console.log(`self-pod node ${sp.node} (${sp.label}) acc ${sp.accID} guard ${sp.guard}`);
  }
  console.log(`wired. hub acc ${marketAccID}, ${pods.size} bot pods, ${selfPods.size} self pods`);
}

// AUTO_REGISTER=1: standing authorization to register creds-missing pods on
// Kamibots (same flow as register-pods.sh). retries with a 10-min backoff.
const regAttemptAt = new Map();
async function ensureRegistered(pod) {
  if (pod.creds) return;
  pod.creds = loadJson(`./kamibots-credentials-pod${pod.node}.json`); // picked up externally?
  if (pod.creds || process.env.AUTO_REGISTER !== "1") return;
  const last = regAttemptAt.get(pod.node) || 0;
  if (Date.now() - last < 600_000) return;
  regAttemptAt.set(pod.node, Date.now());
  try {
    console.log(`🤝 auto-registering pod ${pod.node} on Kamibots…`);
    execSync(`bash ./register-pods.sh ${pod.node}`, {
      cwd: dirname(fileURLToPath(import.meta.url)),
      stdio: "inherit",
    });
    pod.creds = loadJson(`./kamibots-credentials-pod${pod.node}.json`);
    if (pod.creds) console.log(`✅ pod ${pod.node} registered on Kamibots`);
  } catch (e) {
    console.error(`auto-register pod ${pod.node} failed: ${e.message?.slice(0, 160)}`);
  }
}

// pods.json is the source of truth — add-pod.sh appends to it, and the bot
// hot-loads new pods every tick. fully self-sustaining: no restarts needed.
async function refreshPods() {
  const f = loadJson("./pods.json");
  if (!f?.pods) return;
  for (const p of f.pods) {
    const n = Number(p.node);
    if (!pods.has(n)) {
      const pod = {
        node: n,
        label: p.label,
        address: p.address,
        contract: new Contract(p.address, POD_ABI, provider),
        wallet: new Wallet(p.operatorKey, provider),
        accID: null,
        creds: loadJson(`./kamibots-credentials-pod${n}.json`),
      };
      try {
        pod.accID = await pod.contract.accID();
      } catch {
        continue; // not deployed yet; retry next tick
      }
      pods.set(n, pod);
      console.log(`🆕 pod node ${n} (${pod.label}) hot-loaded, acc ${pod.accID}`);
    }
    await ensureRegistered(pods.get(n));
  }
  for (const p of f.selfPods || []) {
    const n = Number(p.node);
    if (selfPods.has(n)) continue;
    const sp = {
      kind: "self",
      node: n,
      label: p.label,
      address: p.address,
      guard: p.guard,
      contract: new Contract(p.address, POD_ABI, provider),
      guardContract: new Contract(p.guard, GUARD_ABI, provider),
      accID: null,
    };
    try {
      sp.accID = await sp.contract.accID();
    } catch {
      continue;
    }
    selfPods.set(n, sp);
    console.log(`🆕 self-pod node ${n} (${sp.label}) hot-loaded, acc ${sp.accID}`);
  }
}

const podByAccID = (acc) =>
  [...pods.values()].find((p) => p.accID === acc) ||
  [...selfPods.values()].find((p) => p.accID === acc) ||
  null;
const kamiSendAs = (wallet) => new Contract(kamiSendAddr, KAMI_SEND_ABI, wallet);

/** ship a kami OUT of `holder` (hub / bot pod / self pod) to targetAddr.
 *  self pods have no operator key — the guard ships, keeper-signed, and the
 *  guard enforces on-chain that the destination is the hub or the owner. */
async function shipOut(holder, idx, targetAddr) {
  if (holder?.kind === "self") {
    const active = await holder.guardContract.harvestOf(idx).catch(() => 0n);
    if (active !== 0n) {
      await (await holder.guardContract.connect(operator).keeperStop(idx)).wait();
      console.log(`⏹️  abandoned self-farm harvest stopped for #${idx}`);
    }
    const tx = await holder.guardContract.connect(operator).ship(idx, targetAddr);
    await tx.wait();
    return tx;
  }
  const wallet = holder === null ? operator : holder.wallet; // null = hub
  const tx = await kamiSendAs(wallet).executeTyped(idx, targetAddr);
  await tx.wait();
  return tx;
}

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

// a running strategy is identified by node AND risk — a style change on the
// same tile must restart the strategy with the new config
const stratSig = (node, risk) => `${node}:${risk}`;

function parsePrefs(idx) {
  let risk = "balanced";
  let node = DEFAULT_NODE;
  let mode = "bot";
  try {
    const p = JSON.parse(state.prefs[idx] || "{}");
    if (p.mode === "self" && selfPods.has(Number(p.node))) {
      mode = "self";
      node = Number(p.node);
    } else if (pods.has(Number(p.node))) node = Number(p.node);
    if (RISK[p.risk]) risk = p.risk;
  } catch {}
  return { risk, node, mode };
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
    state.strategies[tokenIndex] = stratSig(pod.node, risk);
    console.log(`▶️  kami #${tokenIndex} farming node ${pod.node} (${risk}) via ${pod.label}`);
  } catch (e) {
    console.error(`strategy start failed #${tokenIndex} on pod ${pod.node}: ${e.message}`);
  }
}

async function stopStrategy(tokenIndex) {
  const sig = state.strategies[tokenIndex];
  if (sig === undefined) return;
  const node = Number(String(sig).split(":")[0]);
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
// desired location: leased -> renter's pod. unrented -> PARK IN PLACE for the
// grace window (same-tile re-rents start instantly, no 1h send cooldown), then
// back to the hub pool. converge with operator-gated KamiSends; cooldown
// failures simply retry next tick.
async function reconcile(idx, l) {
  const actualAcc = await idOwnsKami.safeGet(l.kamiID).catch(() => null);
  if (actualAcc === null) return;

  const { risk, node, mode } = parsePrefs(idx);
  const leased = l.renter !== "0x0000000000000000000000000000000000000000";
  const holdingPod = podByAccID(actualAcc);
  const targetPod = leased ? (mode === "self" ? selfPods.get(node) : pods.get(node)) : null;

  let desiredAcc;
  if (leased) {
    desiredAcc = targetPod.accID;
    delete state.parkedAt[idx];
  } else if (holdingPod) {
    // unrented in a pod: parked. stay through the grace window, then go home.
    if (state.parkedAt[idx] === undefined) state.parkedAt[idx] = Date.now();
    const parked = Date.now() - state.parkedAt[idx] < PARK_GRACE_MS;
    desiredAcc = parked ? actualAcc : marketAccID;
  } else {
    desiredAcc = marketAccID;
  }

  if (actualAcc === desiredAcc) {
    if (leased && mode === "self") {
      // renter farms it themselves via the guard — never run a bot strategy
      if (state.strategies[idx] !== undefined) await stopStrategy(idx);
      return;
    }
    // right tile: the renter's exact strategy (node AND risk) should be running
    if (leased && state.strategies[idx] !== stratSig(targetPod.node, risk)) {
      if (state.strategies[idx] !== undefined) await stopStrategy(idx);
      await startStrategy(targetPod, idx, risk);
    }
    return;
  }

  // wrong place. never farm while relocating.
  if (state.strategies[idx] !== undefined) await stopStrategy(idx);

  // who currently holds it? (null = the hub itself; outside protocol = not ours)
  const holder = actualAcc === marketAccID ? null : holdingPod;
  if (actualAcc !== marketAccID && !holder) return; // arrival flow or theft alarm owns this

  // destination address: bot pod -> its operator EOA; self pod -> its guard; hub -> hub op
  const toAddr = leased
    ? targetPod.kind === "self"
      ? targetPod.guard
      : targetPod.wallet.address
    : operator.address;
  try {
    const tx = await shipOut(holder, idx, toAddr);
    console.log(`🚚 kami #${idx} shipped -> ${leased ? `${targetPod.kind} pod ${targetPod.node} (${targetPod.label})` : "hub pool"} (${tx.hash})`);
  } catch (e) {
    const msg = e.message?.slice(0, 140) || "";
    if (!/cooldown|resting/i.test(msg)) console.error(`ship #${idx} failed: ${msg}`);
    // else: kami mid-rest or post-send cooldown — retry next tick
  }
}

// ---- return flow: ONE direct KamiSend from wherever the kami is (hub OR a
// parked pod) straight to the owner — no intermediate hop, no extra cooldown
async function sendKamiHome(idx, ownerAddr, kamiID) {
  const at = await idOwnsKami.safeGet(kamiID).catch(() => null);
  if (at === null) return;
  const holder = at === marketAccID ? null : podByAccID(at);
  if (at !== marketAccID && !holder) return; // outside the protocol: theft alarm's turf

  const opAddr = await addrOperator.get(BigInt(ownerAddr)).catch(() => null);
  if (!opAddr || opAddr === "0x0000000000000000000000000000000000000000") {
    console.error(`return #${idx}: owner has no operator on file — manual return needed`);
    return;
  }
  try {
    const tx = await shipOut(holder, idx, opAddr);
    console.log(`🏠 kami #${idx} sent home to ${ownerAddr} (${tx.hash})`);
    const clear = await market.connect(operator).clearReturned(idx);
    await clear.wait();
    delete state.parkedAt[idx];
    console.log(`✅ return finalized on-chain for #${idx}`);
  } catch (e) {
    console.error(`return send failed #${idx}: ${e.message?.slice(0, 160)} (cooldown? retrying next tick)`);
  }
}

// ---- pod sweeps: PAYDAY-ONLY ------------------------------------------------
// settle() pays from the hub inventory, so pod earnings must be consolidated
// before a settle — and ONLY then. no drip-sweeping (each sweep costs the
// in-world transfer fee, which the platform absorbs; once per payday, not per
// tick). the dApp's settle button also force-sweeps as a belt-and-suspenders.
async function sweepPods() {
  try {
    const [last, cd] = await Promise.all([market.lastSettleAt(), market.settleCooldown()]);
    const settleOpen = last === 0n || BigInt(Math.floor(Date.now() / 1000)) >= last + cd;
    if (!settleOpen) return;
  } catch {
    return;
  }
  for (const pod of [...pods.values(), ...selfPods.values()]) {
    try {
      const bal = await pod.contract.musuBalance();
      if (bal >= BigInt(SWEEP_MIN_MUSU)) {
        const tx = await pod.contract.connect(operator).sweepMusu();
        await tx.wait();
        console.log(`🧹 ${pod.kind} pod ${pod.node} swept ${bal} MUSU -> hub (settle window open)`);
      }
    } catch (e) {
      console.error(`sweep pod ${pod.node} failed: ${e.message?.slice(0, 120)}`);
    }
  }
}

// ---- theft alarm ------------------------------------------------------------
async function theftCheck() {
  const allowed = new Set([
    marketAccID,
    ...[...pods.values()].map((p) => p.accID),
    ...[...selfPods.values()].map((p) => p.accID),
  ]);
  const n = Number(await market.numListings());
  for (let i = 0; i < n; i++) {
    const idx = Number(await market.tokenIndices(i));
    const l = await market.listings(idx);
    if (!l.staked || l.returning) continue;
    const at = await idOwnsKami.safeGet(l.kamiID).catch(() => null);
    if (at === null || allowed.has(at)) continue;

    console.error(`🚨🚨 THEFT ALARM: listed kami #${idx} left the protocol (now in acc ${at}) WITHOUT a return request!`);
    writeFileSync(new URL("./THEFT-ALARM.txt", import.meta.url).pathname,
      `${new Date().toISOString()} kami #${idx} moved to acc ${at}\n`, { flag: "a" });

    // LATCH: rotate ONCE per incident, never every tick. after an auto-rotate the
    // stolen kami is still gone (condition persists), so without this the bot
    // would re-rotate — and re-mint keys — on every poll.
    if (state.alarmLatched) {
      console.error(`🔒 alarm already latched — automation cut off; manual intervention required (clear state.alarmLatched to re-arm)`);
      return;
    }

    if (admin) {
      // rotate EVERY key-holding operator to a fresh QUARANTINE key. self pods are
      // skipped: their operator is the guard CONTRACT (no key to compromise).
      const rotations = [["hub", (a) => market.connect(admin).rotateOperator(a)]];
      for (const pod of pods.values())
        rotations.push([`pod ${pod.node}`, (a) => pod.contract.connect(admin).rotateOperator(a)]);

      // fresh keys are written to a 0600 file, NEVER to the log
      const quarantine = {};
      for (const [name, rotate] of rotations) {
        try {
          const fresh = Wallet.createRandom();
          quarantine[name] = { address: fresh.address, privateKey: fresh.privateKey };
          const tx = await rotate(fresh.address);
          await tx.wait();
          console.error(`🔒 ${name} operator rotated to ${fresh.address} (key in quarantine-keys.json, mode 600)`);
        } catch (e) {
          console.error(`rotate ${name} failed: ${e.message?.slice(0, 120)}`);
        }
      }
      const qpath = new URL("./quarantine-keys.json", import.meta.url).pathname;
      writeFileSync(qpath, JSON.stringify({ at: new Date().toISOString(), keys: quarantine }, null, 2), { mode: 0o600 });
      try { chmodSync(qpath, 0o600); } catch {}
      state.alarmLatched = true;
      saveState();
      console.error(`🔒 all operators rotated — automation cut off. keys quarantined; alarm LATCHED (no further auto-rotation).`);
    } else {
      // no admin key on this bot: alert only, and latch so we don't spam the alert
      state.alarmLatched = true;
      saveState();
      console.error(`⚠️  no ADMIN key on this bot — CANNOT auto-rotate. Rotate operators manually NOW. Alarm latched.`);
    }
  }
}

// ---- main loop --------------------------------------------------------------
async function tick() {
  await refreshPods(); // hot-load pods added by add-pod.sh; auto-register if enabled
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
      const at = await idOwnsKami.safeGet(l.kamiID).catch(() => null);
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
      await sendKamiHome(idx, l.owner, l.kamiID); // direct from hub OR pod
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
