#!/usr/bin/env node
// Recover + complete the tile expansion after partial broadcasts.
// Per planned node: find any half-created pod via the account-name reverse
// lookup (accID == uint160(pod address)), finish its registry entry, rotate in
// a FRESH operator (admin = deployer), fund, register on Kamibots, append
// pods.json, and walk it to its room — or run a clean add-pod if nothing exists.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AbiCoder, Contract, JsonRpcProvider, Wallet, getAddress, id as keccakId, toBeHex } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const provider = new JsonRpcProvider(env.YOMINET_RPC);
const deployer = new Wallet(env.DEPLOYER_KEY, provider);
const coder = AbiCoder.defaultAbiCoder();

const world = new Contract(env.WORLD_ADDR, ["function components() view returns (address)"], provider);
const comps = new Contract(await world.components(), ["function getEntitiesWithValue(uint256) view returns (uint256[])"], provider);
const lookup = async (idStr) => {
  const e = await comps.getEntitiesWithValue(BigInt(keccakId(idStr)));
  return getAddress(toBeHex(e[0], 20));
};
const nameComp = new Contract(await lookup("component.name"), ["function getEntitiesWithValue(bytes) view returns (uint256[])"], provider);
const rooms = new Contract(await lookup("component.index.room"), ["function safeGet(uint256) view returns (uint32)"], provider);

const registry = new Contract(
  env.REGISTRY_ADDRESS,
  ["function podForNode(uint32) view returns (address)", "function addPod(address)"],
  provider
);
const POD_ABI = [
  "function accID() view returns (uint256)",
  "function nodeIndex() view returns (uint32)",
  "function admin() view returns (address)",
  "function rotateOperator(address)",
];

const plan = JSON.parse(readFileSync(join(here, "tile-expansion-plan.json"), "utf8")).plan;
const sh = (cmd) =>
  execSync(cmd, {
    cwd: here,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${process.env.HOME}/.nvm/versions/node/v22.22.1/bin:${process.env.PATH}` },
  });

async function accByName(name) {
  const enc = coder.encode(["string"], [name]);
  try {
    const hits = await nameComp.getEntitiesWithValue(enc);
    return hits.length ? hits[0] : null;
  } catch {
    return null;
  }
}

const results = [];
for (const tile of plan) {
  const name = `leasepod${tile.node}12`;
  console.log(`\n=== node ${tile.node} ${tile.name} (${tile.aff}) -> ${name} ===`);
  try {
    let podAddr = await registry.podForNode(tile.node);
    let fromRecovery = false;

    if (podAddr === "0x0000000000000000000000000000000000000000") {
      const acc = await accByName(name);
      if (acc) {
        // half-created: account exists -> its owner IS the pod contract
        podAddr = getAddress(toBeHex(acc, 20));
        const pod = new Contract(podAddr, POD_ABI, provider);
        const node = Number(await pod.nodeIndex());
        if (node !== tile.node) throw new Error(`recovered pod ${podAddr} is for node ${node}?!`);
        console.log(`recovered half-created pod ${podAddr} (registry entry missing) — adding`);
        await (await registry.connect(deployer).addPod(podAddr)).wait();
        fromRecovery = true;
      }
    } else {
      console.log(`pod already in registry: ${podAddr}`);
      fromRecovery = true;
    }

    const podsFile = JSON.parse(readFileSync(join(here, "pods.json"), "utf8"));
    let entry = podsFile.pods.find((p) => Number(p.node) === tile.node);

    if (podAddr === "0x0000000000000000000000000000000000000000") {
      // clean slate: fixed add-pod does everything (slow + skip-simulation now)
      console.log("clean deploy via add-pod.sh…");
      sh(`bash add-pod.sh ${tile.node} "${tile.name} (${tile.aff})" ${name}`);
      const fresh = JSON.parse(readFileSync(join(here, "pods.json"), "utf8"));
      entry = fresh.pods.find((p) => Number(p.node) === tile.node);
      if (!entry) throw new Error("add-pod ran but pods.json has no entry");
      podAddr = entry.address;
    } else if (!entry || fromRecovery) {
      // recovered pod: the original operator key is lost — rotate in a fresh one
      const fresh = Wallet.createRandom();
      const pod = new Contract(podAddr, POD_ABI, provider);
      await (await pod.connect(deployer).rotateOperator(fresh.address)).wait();
      console.log(`operator rotated to ${fresh.address}`);
      await (await deployer.sendTransaction({ to: fresh.address, value: 15_000_000_000_000n })).wait();
      console.log("operator funded 15e12 wei");
      entry = {
        node: tile.node,
        name,
        label: `${tile.name} (${tile.aff})`,
        address: podAddr,
        operator: fresh.address,
        operatorKey: fresh.privateKey,
      };
      const f = JSON.parse(readFileSync(join(here, "pods.json"), "utf8"));
      f.pods = f.pods.filter((p) => Number(p.node) !== tile.node);
      f.pods.push(entry);
      writeFileSync(join(here, "pods.json"), JSON.stringify(f, null, 2), { mode: 0o600 });
      console.log("pods.json updated");
      try {
        sh(`bash register-pods.sh ${tile.node}`);
        console.log("kamibots registered");
      } catch (e) {
        console.error(`kamibots registration failed (bot will retry with AUTO_REGISTER): ${String(e.stderr || e.message).slice(-160)}`);
      }
    }

    const pod = new Contract(podAddr, POD_ABI, provider);
    const accID = await pod.accID();

    let room = Number(await rooms.safeGet(accID));
    for (let attempt = 0; attempt < 3 && room !== tile.room; attempt++) {
      const at = tile.path.indexOf(room);
      const remaining = at >= 0 ? tile.path.slice(at + 1) : tile.path;
      console.log(`walk attempt ${attempt + 1}: at room ${room}, remaining [${remaining.join(",")}]`);
      const jobFile = join(here, `walk-recover-${tile.node}.json`);
      writeFileSync(jobFile, JSON.stringify([{ name: `POD${tile.node}`, acc: accID.toString(), key: entry.operatorKey, path: remaining }]), { mode: 0o600 });
      try {
        sh(`YOMINET_RPC="${env.YOMINET_RPC}" python3 walk-accounts.py ${jobFile}`);
      } finally {
        unlinkSync(jobFile);
      }
      room = Number(await rooms.safeGet(accID));
    }
    if (room !== tile.room) throw new Error(`stuck in room ${room}, wanted ${tile.room}`);
    console.log(`✅ node ${tile.node} pod ${podAddr} room ${room}`);
    results.push({ node: tile.node, ok: true, address: podAddr, room });
  } catch (e) {
    console.error(`❌ node ${tile.node}: ${String(e.message).slice(0, 240)}`);
    results.push({ node: tile.node, ok: false, error: String(e.message).slice(0, 240) });
  }
}

console.log("\n=== SUMMARY ===");
for (const r of results) console.log(r.ok ? `✅ node ${r.node} ${r.address} room ${r.room}` : `❌ node ${r.node}: ${r.error}`);
const okCount = results.filter((r) => r.ok).length;
console.log(`${okCount}/${plan.length} tiles live`);
writeFileSync(join(here, "tile-expansion-result.json"), JSON.stringify(results, null, 2));
process.exit(okCount === plan.length ? 0 : 1);
