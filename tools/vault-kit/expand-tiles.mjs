#!/usr/bin/env node
// Deploy a RoomPod on every farmable wilds tile from tile-expansion-plan.json:
// add-pod.sh (deploy + registry + fund + Kamibots) then a VERIFIED walk with
// retry — after each walk the on-chain room is checked and any remaining hops
// are re-attempted (the RPC-null-but-landed move bug bites otherwise).
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, id as keccakId } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const provider = new JsonRpcProvider(env.YOMINET_RPC);
const world = new Contract(
  env.WORLD_ADDR,
  ["function components() view returns (address)"],
  provider
);
const comps = new Contract(
  await world.components(),
  ["function getEntitiesWithValue(uint256) view returns (uint256[])"],
  provider
);
const lookup = async (idStr) => {
  const e = await comps.getEntitiesWithValue(BigInt(keccakId(idStr)));
  return "0x" + e[0].toString(16).padStart(40, "0");
};
const rooms = new Contract(
  await lookup("component.index.room"),
  ["function safeGet(uint256) view returns (uint32)"],
  provider
);

const plan = JSON.parse(readFileSync(join(here, "tile-expansion-plan.json"), "utf8")).plan;
const sh = (cmd) =>
  execSync(cmd, { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${process.env.HOME}/.nvm/versions/node/v22.22.1/bin:${process.env.PATH}` } });

const results = [];
for (const tile of plan) {
  const name = `leasepod${tile.node}12`;
  const label = `${tile.name} (${tile.aff})`;
  console.log(`\n=== node ${tile.node} ${label} -> ${name} (${tile.hops} hops) ===`);
  try {
    try {
      const out = sh(`bash add-pod.sh ${tile.node} "${label}" ${name}`);
      console.log(out.split("\n").filter((l) => /===|pod|funded|registered|done/i.test(l)).slice(-8).join("\n"));
    } catch (e) {
      const msg = String(e.stdout || "") + " STDERR: " + String(e.stderr || e.message);
      if (!/already has a pod/.test(msg)) throw new Error(`add-pod failed: ${msg.slice(-300)}`);
      console.log("pod already deployed — continuing to walk check");
    }

    const pods = JSON.parse(readFileSync(join(here, "pods.json"), "utf8"));
    const entry = pods.pods.find((p) => Number(p.node) === tile.node);
    if (!entry) throw new Error("pod missing from pods.json after add-pod");
    const pod = new Contract(entry.address, ["function accID() view returns (uint256)"], provider);
    const accID = await pod.accID();

    // verified walk with retry: re-derive remaining hops from the CURRENT room
    let room = Number(await rooms.safeGet(accID));
    for (let attempt = 0; attempt < 3 && room !== tile.room; attempt++) {
      const at = tile.path.indexOf(room);
      const remaining = at >= 0 ? tile.path.slice(at + 1) : tile.path;
      console.log(`walk attempt ${attempt + 1}: at room ${room}, remaining [${remaining.join(",")}]`);
      const jobFile = join(here, `walk-expand-${tile.node}.json`);
      writeFileSync(jobFile, JSON.stringify([{ name: `POD${tile.node}`, acc: accID.toString(), key: entry.operatorKey, path: remaining }]), { mode: 0o600 });
      try {
        sh(`YOMINET_RPC="${env.YOMINET_RPC}" python3 walk-accounts.py ${jobFile}`);
      } finally {
        unlinkSync(jobFile);
      }
      room = Number(await rooms.safeGet(accID));
    }
    if (room !== tile.room) throw new Error(`stuck in room ${room}, wanted ${tile.room}`);
    console.log(`✅ node ${tile.node} pod ${entry.address} parked in room ${room}, kamibots ${entry ? "creds pending check" : ""}`);
    results.push({ node: tile.node, ok: true, address: entry.address, room });
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
