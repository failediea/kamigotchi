#!/usr/bin/env node
// Compute every FARMABLE WILDS tile: MUSU-dropping node whose room a fresh
// account can walk to from spawn (room 1) through ungated rooms only.
// Outputs the expansion plan (existing pods excluded) with walk paths + cost.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Wallet, formatEther } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const creds = JSON.parse(readFileSync(join(here, "kamibots-credentials-pod1.json"), "utf8"));
const H = { "X-Agent-Key": creds.apiKey };

const [nodesRaw, roomsRaw] = await Promise.all([
  fetch("https://api.kamibots.xyz/api/playwright/nodes", { headers: H }).then((r) => r.json()),
  fetch("https://api.kamibots.xyz/api/playwright/rooms", { headers: H }).then((r) => r.json()),
]);
const nodes = Array.isArray(nodesRaw) ? nodesRaw : nodesRaw.nodes ?? Object.values(nodesRaw);
const rooms = Array.isArray(roomsRaw) ? roomsRaw : roomsRaw.rooms ?? Object.values(roomsRaw);

// room graph: same z, one step on x or y, plus explicit exits; gated rooms are dead ends
const byIndex = new Map();
for (const r of rooms) {
  const idx = Number(r.index ?? r.roomIndex);
  const loc = r.location ?? r.coords ?? r;
  byIndex.set(idx, {
    idx,
    x: Number(loc.x), y: Number(loc.y), z: Number(loc.z),
    exits: (r.exits ?? []).map(Number).filter(Number.isFinite),
    gates: r.gates ?? r.requirements ?? null,
    name: r.name,
  });
}
const gated = (r) => {
  const g = r.gates;
  if (!g) return false;
  if (Array.isArray(g)) return g.length > 0;
  if (typeof g === "object") return Object.keys(g).length > 0;
  return Boolean(g);
};
const neighbors = (r) => {
  const out = new Set(r.exits);
  for (const o of byIndex.values()) {
    if (o.idx === r.idx || o.z !== r.z) continue;
    const dx = Math.abs(o.x - r.x), dy = Math.abs(o.y - r.y);
    if ((dx === 1 && dy === 0) || (dx === 0 && dy === 1)) out.add(o.idx);
  }
  return [...out];
};

// BFS from spawn room 1; never ENTER a gated room
const SPAWN = 1;
const prev = new Map([[SPAWN, null]]);
const queue = [SPAWN];
while (queue.length) {
  const cur = queue.shift();
  const r = byIndex.get(cur);
  if (!r) continue;
  for (const n of neighbors(r)) {
    if (prev.has(n)) continue;
    const nr = byIndex.get(n);
    if (!nr || gated(nr)) continue;
    prev.set(n, cur);
    queue.push(n);
  }
}
const pathTo = (room) => {
  if (!prev.has(room)) return null;
  const path = [];
  for (let c = room; c !== SPAWN; c = prev.get(c)) path.unshift(c);
  return path;
};

const existing = new Set([1, 2, 3]); // live bot pods
const plan = [];
const skipped = [];
for (const n of nodes) {
  const idx = Number(n.index ?? n.nodeIndex);
  const room = Number(n.roomIndex ?? n.room);
  const drops = (n.drops ?? []).map((d) => d.name);
  const aff = (n.affinity ?? []).join("/") || "NORMAL";
  const entry = { node: idx, name: n.name, room, aff, drops };
  if (!drops.includes("MUSU")) { skipped.push({ ...entry, why: "non-MUSU drop (" + drops.join(",") + ")" }); continue; }
  if (n.disabled || n.is?.disabled) { skipped.push({ ...entry, why: "disabled" }); continue; }
  const roomInfo = byIndex.get(room);
  if (!roomInfo) { skipped.push({ ...entry, why: "room not in map" }); continue; }
  if (gated(roomInfo)) { skipped.push({ ...entry, why: "room gated" }); continue; }
  const path = pathTo(room);
  if (path === null) { skipped.push({ ...entry, why: "unreachable ungated" }); continue; }
  if (existing.has(idx)) { skipped.push({ ...entry, why: "pod already live" }); continue; }
  plan.push({ ...entry, hops: path.length, path });
}
plan.sort((a, b) => a.hops - b.hops || a.node - b.node);

const MOVE_WEI = 2_250_000_000_000n;
const BASE_FUND = 5_000_000_000_000n; // strategy gas reserve per pod
let total = 0n;
for (const p of plan) total += BASE_FUND + MOVE_WEI * BigInt(p.hops + 1);

const provider = new JsonRpcProvider(env.YOMINET_RPC);
const deployer = new Wallet(env.DEPLOYER_KEY, provider);
const balance = await provider.getBalance(deployer.address);

const out = { computedAt: null, plan, skipped, fundingPerPodBase: BASE_FUND.toString(), estTotalWei: total.toString(), deployerWei: balance.toString(), affordable: balance > total + 50_000_000_000_000n };
writeFileSync(join(here, "tile-expansion-plan.json"), JSON.stringify(out, null, 2));
console.log(`FARMABLE NEW TILES: ${plan.length}`);
for (const p of plan) console.log(`  node ${p.node} ${p.name} (${p.aff}) room ${p.room} hops ${p.hops}`);
console.log(`SKIPPED: ${skipped.length}`);
for (const s of skipped) console.log(`  node ${s.node} ${s.name}: ${s.why}`);
console.log(`est funding+walk cost: ${formatEther(total)} ETH · deployer has ${formatEther(balance)} ETH · affordable: ${out.affordable}`);
