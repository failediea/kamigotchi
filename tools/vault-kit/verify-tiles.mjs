#!/usr/bin/env node
// Park node 12 (toll-gated room) then verify the full tile fleet end to end:
// registry <-> pods.json <-> on-chain rooms <-> kamibots creds.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, getAddress, id as keccakId, toBeHex } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const provider = new JsonRpcProvider(env.YOMINET_RPC);
const deployer = new Wallet(env.DEPLOYER_KEY, provider);

const world = new Contract(env.WORLD_ADDR, ["function components() view returns (address)"], provider);
const comps = new Contract(await world.components(), ["function getEntitiesWithValue(uint256) view returns (uint256[])"], provider);
const lookup = async (idStr) => {
  const e = await comps.getEntitiesWithValue(BigInt(keccakId(idStr)));
  return getAddress(toBeHex(e[0], 20));
};
const rooms = new Contract(await lookup("component.index.room"), ["function safeGet(uint256) view returns (uint32)"], provider);

const registry = new Contract(
  env.REGISTRY_ADDRESS,
  [
    "function podForNode(uint32) view returns (address)",
    "function removePod(address)",
    "function allPods() view returns (address[] addrs, uint32[] nodes, uint256[] accIDs, string[] labels)",
  ],
  provider
);

// 1) park node 12 (bridge-room toll blocks entry for fresh accounts)
const pod12 = await registry.podForNode(12);
if (pod12 !== "0x0000000000000000000000000000000000000000") {
  await (await registry.connect(deployer).removePod(pod12)).wait();
  console.log(`node 12 parked: ${pod12} removed from registry (toll-gated room)`);
}
const podsFile = JSON.parse(readFileSync(join(here, "pods.json"), "utf8"));
const before = podsFile.pods.length;
const parked = podsFile.pods.find((p) => Number(p.node) === 12) || null;
podsFile.pods = podsFile.pods.filter((p) => Number(p.node) !== 12);
if (podsFile.pods.length !== before) {
  writeFileSync(join(here, "pods.json"), JSON.stringify(podsFile, null, 2), { mode: 0o600 });
  writeFileSync(join(here, "parked-pod12.json"), JSON.stringify(parked, null, 2), { mode: 0o600 });
  console.log("pods.json: node 12 entry moved to parked-pod12.json (re-add once toll is solved)");
}

// 2) verify the fleet
const [addrs, nodes, accIDs, labels] = await registry.allPods();
console.log(`\nregistry pods: ${addrs.length}`);
let allOk = true;
for (let i = 0; i < addrs.length; i++) {
  const node = Number(nodes[i]);
  const room = Number(await rooms.safeGet(accIDs[i]));
  const entry = podsFile.pods.find((p) => Number(p.node) === node);
  const creds = (() => {
    try {
      readFileSync(join(here, `kamibots-credentials-pod${node}.json`));
      return true;
    } catch {
      return false;
    }
  })();
  const ok = room === node && !!entry && creds;
  allOk = allOk && ok;
  console.log(`${ok ? "✅" : "❌"} node ${node} ${labels[i]} — room ${room}${room !== node ? " (WRONG)" : ""} · pods.json ${entry ? "✓" : "MISSING"} · kamibots ${creds ? "✓" : "MISSING"}`);
}
const bal = await provider.getBalance(deployer.address);
console.log(`\ndeployer remaining: ${bal} wei`);
console.log(allOk ? "FLEET VERIFIED ✅" : "FLEET HAS ISSUES ❌");
process.exit(allOk ? 0 : 1);
