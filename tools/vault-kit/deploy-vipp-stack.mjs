#!/usr/bin/env node
// Deploy the PARALLEL VIPP MARKET: same KamiLeaseMarket code, payItem = 2.
// Hub + registry + one pod per walkable VIPP tile, own ops dir for the bot.
// Idempotent: reruns skip completed stages via vipp-deployment.json.
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, getAddress, id as keccakId, toBeHex } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = resolve(here, "../../packages/contracts");
const vippDir = resolve(here, "../vault-kit-vipp");
const forge = `${process.env.HOME}/.foundry/bin/forge`;
const PAY_ITEM = "2";
const HUB_NAME = "leasehubvip";

const env = Object.fromEntries(
  readFileSync(join(here, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const provider = new JsonRpcProvider(env.YOMINET_RPC);
const deployer = new Wallet(env.DEPLOYER_KEY, provider);

const statePath = join(here, "vipp-deployment.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });

const plan = JSON.parse(readFileSync(join(here, "vipp-tile-plan.json"), "utf8")).plan;
console.log(`VIPP tiles: ${plan.map((p) => p.node).join(", ")}`);

function runForge(script, extraEnv) {
  const r = spawnSync(
    forge,
    ["script", script, "--rpc-url", env.YOMINET_RPC, "--private-key", env.DEPLOYER_KEY, "--legacy", "--optimizer-runs", "1", "--broadcast", "--slow", "--skip-simulation"],
    { cwd: contractsDir, env: { ...process.env, ...extraEnv }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  if (r.status !== 0) throw new Error(`forge ${script} failed: ${out.split("\n").slice(-25).join("\n")}`);
  return out;
}
const one = (text, label) => {
  const m = text.match(new RegExp(`${label}:\\s*(0x[a-fA-F0-9]{40})`));
  if (!m) throw new Error(`missing ${label} in forge output`);
  return getAddress(m[1]);
};
const many = (text, label) =>
  [...text.matchAll(new RegExp(`${label}:\\s*(0x[a-fA-F0-9]{40})`, "g"))].map((m) => getAddress(m[1]));
async function requireCode(addr, label) {
  if ((await provider.getCode(addr)) === "0x") throw new Error(`${label} has no code: ${addr}`);
}

// ---- 1. hub -----------------------------------------------------------------
if (!state.hub?.address || (await provider.getCode(state.hub.address)) === "0x") {
  const hubOp = Wallet.createRandom();
  console.log("=== deploy VIPP hub ===");
  const out = runForge("script/DeployKamiLeaseMarket.s.sol:DeployKamiLeaseMarket", {
    WORLD_ADDR: env.WORLD_ADDR,
    MARKET_OPERATOR: hubOp.address,
    MARKET_SETTLER: hubOp.address,
    MARKET_NAME: HUB_NAME,
    MGMT_BPS: "1000",
    MGMT_ACC_ID: env.MGMT_ACC_ID || "0",
    PAY_ITEM,
  });
  const address = one(out, "KamiLeaseMarket");
  await requireCode(address, "vipp hub");
  state.hub = { address, operator: hubOp.address, operatorKey: hubOp.privateKey, name: HUB_NAME };
  save();
  console.log(`vipp hub: ${address} (operator/settler ${hubOp.address})`);
} else console.log(`vipp hub exists: ${state.hub.address}`);

// ---- 2. pods + registry -----------------------------------------------------
if (!state.registry?.address || (await provider.getCode(state.registry.address)) === "0x") {
  console.log("=== deploy VIPP pods ===");
  const extra = { WORLD_ADDR: env.WORLD_ADDR, HUB_ADDR: state.hub.address, POD_COUNT: String(plan.length), PAY_ITEM };
  state.podKeys = state.podKeys || {};
  plan.forEach((tile, i) => {
    const w = state.podKeys[tile.node] ? new Wallet(state.podKeys[tile.node]) : Wallet.createRandom();
    state.podKeys[tile.node] = w.privateKey;
    extra[`POD${i + 1}_NODE`] = String(tile.node);
    extra[`POD${i + 1}_LABEL`] = `${tile.name} (${tile.aff})`;
    extra[`POD${i + 1}_OPERATOR`] = w.address;
    extra[`POD${i + 1}_NAME`] = `vippod${tile.node}12`;
  });
  save();
  const out = runForge("script/DeployLeasePods.s.sol:DeployLeasePods", extra);
  const registry = one(out, "LeasePodRegistry");
  const podAddrs = many(out, "RoomPod");
  if (podAddrs.length !== plan.length) throw new Error(`expected ${plan.length} pods, got ${podAddrs.length}`);
  await requireCode(registry, "vipp registry");
  for (const a of podAddrs) await requireCode(a, "vipp pod");
  state.registry = { address: registry };
  state.pods = plan.map((tile, i) => ({
    node: tile.node,
    name: `vippod${tile.node}12`,
    label: `${tile.name} (${tile.aff})`,
    address: podAddrs[i],
    operator: new Wallet(state.podKeys[tile.node]).address,
    operatorKey: state.podKeys[tile.node],
  }));
  save();
  console.log(`vipp registry: ${registry}, ${podAddrs.length} pods`);
} else console.log(`vipp registry exists: ${state.registry.address}`);

// ---- 3. fund operators ------------------------------------------------------
const targets = [
  { addr: state.hub.operator, want: 10_000_000_000_000n },
  ...state.pods.map((p) => ({ addr: p.operator, want: 25_000_000_000_000n })), // deep walks: 6-9 hops
];
for (const t of targets) {
  const bal = await provider.getBalance(t.addr);
  if (bal < t.want) {
    await (await deployer.sendTransaction({ to: t.addr, value: t.want - bal })).wait();
    console.log(`funded ${t.addr} -> ${t.want} wei`);
  }
}

// ---- 4. ops dir -------------------------------------------------------------
mkdirSync(vippDir, { recursive: true, mode: 0o700 });
const vippEnv = [
  `YOMINET_RPC=${env.YOMINET_RPC}`,
  `WORLD_ADDR=${env.WORLD_ADDR}`,
  `MARKET_ADDRESS=${state.hub.address}`,
  `REGISTRY_ADDRESS=${state.registry.address}`,
  `OPERATOR_PRIVATE_KEY=${state.hub.operatorKey}`,
  `MGMT_ACC_ID=${env.MGMT_ACC_ID || ""}`,
  "AUTO_REGISTER=1",
].join("\n") + "\n";
writeFileSync(join(vippDir, ".env"), vippEnv, { mode: 0o600 });
writeFileSync(join(vippDir, "pods.json"), JSON.stringify({ pods: state.pods, selfPods: [] }, null, 2), { mode: 0o600 });
for (const f of ["register-pods.sh", "kamibots-onboard.mjs", "walk-accounts.py"]) {
  copyFileSync(join(here, f), join(vippDir, f));
}
chmodSync(join(vippDir, "register-pods.sh"), 0o755);
console.log(`ops dir ready: ${vippDir}`);

// ---- 5. kamibots registrations ----------------------------------------------
const reg = spawnSync("bash", ["register-pods.sh"], { cwd: vippDir, encoding: "utf8", env: { ...process.env, PATH: `${process.env.HOME}/.nvm/versions/node/v22.22.1/bin:${process.env.PATH}` } });
console.log((reg.stdout || "").split("\n").filter((l) => /pod|registered|done/i.test(l)).join("\n"));
if (reg.status !== 0) console.error(`register-pods issues (bot AUTO_REGISTER retries): ${(reg.stderr || "").slice(-200)}`);

// ---- 6. verified walks ------------------------------------------------------
const world = new Contract(env.WORLD_ADDR, ["function components() view returns (address)"], provider);
const comps = new Contract(await world.components(), ["function getEntitiesWithValue(uint256) view returns (uint256[])"], provider);
const roomsAddr = getAddress(toBeHex((await comps.getEntitiesWithValue(BigInt(keccakId("component.index.room"))))[0], 20));
const rooms = new Contract(roomsAddr, ["function safeGet(uint256) view returns (uint32)"], provider);

const results = [];
for (const tile of plan) {
  const entry = state.pods.find((p) => p.node === tile.node);
  const pod = new Contract(entry.address, ["function accID() view returns (uint256)"], provider);
  const accID = await pod.accID();
  let room = Number(await rooms.safeGet(accID));
  for (let attempt = 0; attempt < 3 && room !== tile.room; attempt++) {
    const at = tile.path.indexOf(room);
    const remaining = at >= 0 ? tile.path.slice(at + 1) : tile.path;
    console.log(`node ${tile.node} walk ${attempt + 1}: at ${room}, remaining [${remaining.join(",")}]`);
    const jobFile = join(vippDir, `walk-${tile.node}.json`);
    writeFileSync(jobFile, JSON.stringify([{ name: `VIPPOD${tile.node}`, acc: accID.toString(), key: entry.operatorKey, path: remaining }]), { mode: 0o600 });
    try {
      execSync(`YOMINET_RPC="${env.YOMINET_RPC}" python3 walk-accounts.py walk-${tile.node}.json`, { cwd: vippDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {}
    try { unlinkSync(jobFile); } catch {}
    room = Number(await rooms.safeGet(accID));
  }
  const ok = room === tile.room;
  console.log(`${ok ? "✅" : "❌"} vipp node ${tile.node} ${entry.label} — room ${room}`);
  results.push({ node: tile.node, ok, room, address: entry.address });
}

// ---- 7. verify hub ----------------------------------------------------------
const hub = new Contract(state.hub.address, ["function payItem() view returns (uint32)", "function accID() view returns (uint256)", "function operatorAddr() view returns (address)", "function settler() view returns (address)"], provider);
const [pi, accID, op, settler] = await Promise.all([hub.payItem(), hub.accID(), hub.operatorAddr(), hub.settler()]);
console.log(`\nhub payItem=${pi} accID=${accID}`);
console.log(`operator/settler match: ${op === state.hub.operator && settler === state.hub.operator}`);
const okCount = results.filter((r) => r.ok).length;
console.log(`VIPP FLEET: ${okCount}/${plan.length} tiles in place`);
console.log(`deployer left: ${await provider.getBalance(deployer.address)} wei`);
state.results = results;
save();
process.exit(okCount === plan.length && Number(pi) === 2 ? 0 : 1);
