#!/usr/bin/env node
// POOLS-AS-A-SERVICE provisioner: deploy a dedicated customer pool end to end.
//
//   node provision-pool.mjs pool-spec.json
//
// pool-spec.json:
//   {
//     "name": "whalepool1",          // game account name, <=16 chars, unique
//     "label": "Whale's EERIE pool", // storefront label
//     "payItem": 1,                  // 1 = MUSU, 2 = VIPP
//     "customer": "0x…",             // wallet that will hold the admin key
//     "mgmtBps": 1000,               // OUR service fee (lower-only forever)
//     "tiles": [1, 29]               // nodes from tile-expansion-plan/vipp-tile-plan
//   }
//
// Stages (idempotent via provision-<name>.json): deploy hub -> pods+registry ->
// fund -> ops dir -> kamibots registrations -> verified walks -> directory.add
// -> transferAdmin(customer)  [customer accepts from the dApp banner].
// Reuses the exact stages that shipped the flagship + VIPP stacks.
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, getAddress, id as keccakId, toBeHex } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = resolve(here, "../../packages/contracts");
const forge = `${process.env.HOME}/.foundry/bin/forge`;

const specPath = process.argv[2];
if (!specPath) throw new Error("usage: node provision-pool.mjs <pool-spec.json>");
const spec = JSON.parse(readFileSync(specPath, "utf8"));
for (const k of ["name", "label", "payItem", "customer", "mgmtBps", "tiles"]) {
  if (spec[k] === undefined) throw new Error(`spec missing ${k}`);
}
const poolDir = resolve(here, `../pools/${spec.name}`);
const env = Object.fromEntries(
  readFileSync(join(here, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const provider = new JsonRpcProvider(env.YOMINET_RPC);
const deployer = new Wallet(env.DEPLOYER_KEY, provider);

const planFile = spec.payItem === 2 ? "vipp-tile-plan.json" : "tile-expansion-plan.json";
const fullPlan = JSON.parse(readFileSync(join(here, planFile), "utf8"));
const knownTiles = new Map(fullPlan.plan.map((p) => [p.node, p]));
// flagship tiles aren't in the expansion plan — synthesize their entries
for (const [node, room, name, aff, path] of [
  [1, 1, "Misty Riverside", "EERIE", []],
  [2, 2, "Tunnel of Trees", "NORMAL", [29, 2]],
  [3, 3, "Torii Gate", "NORMAL", [29, 2, 3]],
]) {
  if (!knownTiles.has(node)) knownTiles.set(node, { node, room, name, aff, path, hops: path.length });
}
const tiles = spec.tiles.map((n) => {
  const t = knownTiles.get(n);
  if (!t) throw new Error(`tile ${n} is not in ${planFile} (not farmable for payItem ${spec.payItem}?)`);
  return t;
});

const statePath = join(here, `provision-${spec.name}.json`);
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });

function runForge(script, extraEnv) {
  const r = spawnSync(
    forge,
    ["script", script, "--rpc-url", env.YOMINET_RPC, "--private-key", env.DEPLOYER_KEY, "--legacy", "--optimizer-runs", "1", "--broadcast", "--slow", "--skip-simulation"],
    { cwd: contractsDir, env: { ...process.env, ...extraEnv }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  if (r.status !== 0) throw new Error(`forge ${script} failed: ${out.split("\n").slice(-20).join("\n")}`);
  return out;
}
const one = (text, label) => {
  const m = text.match(new RegExp(`${label}:\\s*(0x[a-fA-F0-9]{40})`));
  if (!m) throw new Error(`missing ${label}`);
  return getAddress(m[1]);
};
const many = (text, label) =>
  [...text.matchAll(new RegExp(`${label}:\\s*(0x[a-fA-F0-9]{40})`, "g"))].map((m) => getAddress(m[1]));

// ---- 1. hub (platform is admin during provisioning) -------------------------
if (!state.hub?.address || (await provider.getCode(state.hub.address)) === "0x") {
  const hubOp = Wallet.createRandom();
  const out = runForge("script/DeployKamiLeaseMarket.s.sol:DeployKamiLeaseMarket", {
    WORLD_ADDR: env.WORLD_ADDR,
    MARKET_OPERATOR: hubOp.address,
    MARKET_SETTLER: hubOp.address,
    MARKET_NAME: spec.name,
    MGMT_BPS: String(spec.mgmtBps),
    MGMT_ACC_ID: env.MGMT_ACC_ID || "0", // fees flow to the PLATFORM account
    PAY_ITEM: String(spec.payItem),
  });
  state.hub = { address: one(out, "KamiLeaseMarket"), operator: hubOp.address, operatorKey: hubOp.privateKey };
  save();
  console.log("hub:", state.hub.address);
} else console.log("hub exists:", state.hub.address);

// ---- 2. pods + registry ------------------------------------------------------
if (!state.registry?.address || (await provider.getCode(state.registry.address)) === "0x") {
  const extra = { WORLD_ADDR: env.WORLD_ADDR, HUB_ADDR: state.hub.address, POD_COUNT: String(tiles.length), PAY_ITEM: String(spec.payItem) };
  state.podKeys = state.podKeys || {};
  tiles.forEach((tile, i) => {
    const w = state.podKeys[tile.node] ? new Wallet(state.podKeys[tile.node]) : Wallet.createRandom();
    state.podKeys[tile.node] = w.privateKey;
    extra[`POD${i + 1}_NODE`] = String(tile.node);
    extra[`POD${i + 1}_LABEL`] = `${tile.name} (${tile.aff})`;
    extra[`POD${i + 1}_OPERATOR`] = w.address;
    extra[`POD${i + 1}_NAME`] = `${spec.name.slice(0, 10)}p${tile.node}`;
  });
  save();
  const out = runForge("script/DeployLeasePods.s.sol:DeployLeasePods", extra);
  state.registry = { address: one(out, "LeasePodRegistry") };
  const podAddrs = many(out, "RoomPod");
  state.pods = tiles.map((tile, i) => ({
    node: tile.node,
    name: `${spec.name.slice(0, 10)}p${tile.node}`,
    label: `${tile.name} (${tile.aff})`,
    address: podAddrs[i],
    operator: new Wallet(state.podKeys[tile.node]).address,
    operatorKey: state.podKeys[tile.node],
  }));
  save();
  console.log("registry:", state.registry.address, "+", podAddrs.length, "pods");
} else console.log("registry exists:", state.registry.address);

// ---- 3. fund ------------------------------------------------------------------
for (const t of [
  { addr: state.hub.operator, want: 10_000_000_000_000n },
  ...state.pods.map((p, i) => ({ addr: p.operator, want: BigInt(5_000_000_000_000 + 2_250_000_000_000 * (tiles[i].hops + 2)) })),
]) {
  const bal = await provider.getBalance(t.addr);
  if (bal < t.want) await (await deployer.sendTransaction({ to: t.addr, value: t.want - bal })).wait();
}
console.log("operators funded");

// ---- 4. ops dir + registrations + walks ---------------------------------------
mkdirSync(poolDir, { recursive: true, mode: 0o700 });
writeFileSync(
  join(poolDir, ".env"),
  [
    `YOMINET_RPC=${env.YOMINET_RPC}`,
    `WORLD_ADDR=${env.WORLD_ADDR}`,
    `MARKET_ADDRESS=${state.hub.address}`,
    `REGISTRY_ADDRESS=${state.registry.address}`,
    `OPERATOR_PRIVATE_KEY=${state.hub.operatorKey}`,
    "AUTO_REGISTER=1",
  ].join("\n") + "\n",
  { mode: 0o600 }
);
writeFileSync(join(poolDir, "pods.json"), JSON.stringify({ pods: state.pods, selfPods: [] }, null, 2), { mode: 0o600 });
for (const f of ["register-pods.sh", "kamibots-onboard.mjs", "walk-accounts.py"]) copyFileSync(join(here, f), join(poolDir, f));
chmodSync(join(poolDir, "register-pods.sh"), 0o755);
try { execSync(`ln -sfn ${join(here, "node_modules")} ${join(poolDir, "node_modules")}`); } catch {}
const reg = spawnSync("bash", ["register-pods.sh"], { cwd: poolDir, encoding: "utf8", env: { ...process.env, PATH: `${process.env.HOME}/.nvm/versions/node/v22.22.1/bin:${process.env.PATH}` } });
console.log((reg.stdout || "").split("\n").filter((l) => /done|already/.test(l)).join("\n"));

const world = new Contract(env.WORLD_ADDR, ["function components() view returns (address)"], provider);
const comps = new Contract(await world.components(), ["function getEntitiesWithValue(uint256) view returns (uint256[])"], provider);
const rooms = new Contract(
  getAddress(toBeHex((await comps.getEntitiesWithValue(BigInt(keccakId("component.index.room"))))[0], 20)),
  ["function safeGet(uint256) view returns (uint32)"],
  provider
);
for (const tile of tiles) {
  const entry = state.pods.find((p) => p.node === tile.node);
  const pod = new Contract(entry.address, ["function accID() view returns (uint256)"], provider);
  const accID = await pod.accID();
  let room = Number(await rooms.safeGet(accID));
  for (let attempt = 0; attempt < 3 && room !== tile.room; attempt++) {
    const at = tile.path.indexOf(room);
    const remaining = at >= 0 ? tile.path.slice(at + 1) : tile.path;
    if (!remaining.length) break;
    const jobFile = join(poolDir, `walk-${tile.node}.json`);
    writeFileSync(jobFile, JSON.stringify([{ name: `P${tile.node}`, acc: accID.toString(), key: entry.operatorKey, path: remaining }]), { mode: 0o600 });
    try {
      execSync(`YOMINET_RPC="${env.YOMINET_RPC}" python3 walk-accounts.py walk-${tile.node}.json`, { cwd: poolDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {}
    try { unlinkSync(jobFile); } catch {}
    room = Number(await rooms.safeGet(accID));
  }
  console.log(`${room === tile.room ? "✅" : "❌"} tile ${tile.node} room ${room}`);
  if (room !== tile.room) throw new Error(`tile ${tile.node} not in place`);
}

// ---- 5. storefront listing -----------------------------------------------------
const dirState = JSON.parse(readFileSync(join(here, "directory-deployment.json"), "utf8"));
const directory = new Contract(
  dirState.address,
  ["function add(address,address,address,string)", "function all() view returns (tuple(address hub, address podRegistry, address selfRegistry, string label)[])"],
  deployer
);
const listed = new Set((await directory.all()).map((r) => r.hub.toLowerCase()));
if (!listed.has(state.hub.address.toLowerCase())) {
  await (await directory.add(state.hub.address, state.registry.address, "0x0000000000000000000000000000000000000000", spec.label)).wait();
  console.log("listed in the storefront directory");
}

// ---- 6. hand the admin key to the customer --------------------------------------
const hub = new Contract(
  state.hub.address,
  ["function pendingAdmin() view returns (address)", "function admin() view returns (address)", "function transferAdmin(address)"],
  deployer
);
const [adminNow, pending] = await Promise.all([hub.admin(), hub.pendingAdmin()]);
if (adminNow.toLowerCase() === deployer.address.toLowerCase() && pending.toLowerCase() !== spec.customer.toLowerCase()) {
  await (await hub.transferAdmin(spec.customer)).wait();
  console.log(`admin PROPOSED to customer ${spec.customer} — they accept from the dApp banner`);
} else {
  console.log(`admin state: admin=${adminNow} pending=${pending}`);
}

console.log(`\nPOOL PROVISIONED: ${spec.label}`);
console.log(`hub ${state.hub.address} · registry ${state.registry.address} · ${state.pods.length} tiles`);
console.log(`NEXT: (1) start its keeper — systemd unit with OPS_DIR=${poolDir}`);
console.log(`      (2) customer clicks "Accept pool ownership" in the dApp`);
if (spec.payItem === 2) console.log(`      (3) seed MUSU floats: ${spec.name} + each pod account (~300 MUSU each)`);
