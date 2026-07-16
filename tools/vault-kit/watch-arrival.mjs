// Watch the market's game account for an incoming kami (via KamiSend).
// Read-only. Prints the kami entity + token index when one arrives, then exits.
import { JsonRpcProvider, Contract, id as keccakId } from "ethers";

const RPC = "https://jsonrpc-yominet-1.anvil.asia-southeast.initia.xyz";
const WORLD = "0x2729174c265dbBd8416C6449E0E813E88f43D0E7";
const MARKET_ACC_ID = 43044749590305112253161995254083490137683785545n; // uint160(market v2)

const WORLD_ABI = ["function components() view returns (address)"];
const REGISTRY_ABI = ["function getEntitiesWithValue(uint256 value) view returns (uint256[])"];
const COMP_ABI = [
  "function getEntitiesWithValue(uint256 value) view returns (uint256[])",
  "function getValue(uint256 entity) view returns (uint256)",
  "function has(uint256 entity) view returns (bool)",
];

const provider = new JsonRpcProvider(RPC);
const world = new Contract(WORLD, WORLD_ABI, provider);
const registryAddr = await world.components();
const registry = new Contract(registryAddr, REGISTRY_ABI, provider);

async function compAddr(idStr) {
  const entities = await registry.getEntitiesWithValue(BigInt(keccakId(idStr)));
  if (!entities.length) throw new Error(`component not found: ${idStr}`);
  return "0x" + entities[0].toString(16).padStart(40, "0");
}

const idOwnsKami = new Contract(await compAddr("component.id.kami.owns"), COMP_ABI, provider);
// kami token index component (per kamistats: component.index.kami)
let indexComp = null;
for (const guess of ["component.index.kami", "component.kami.index", "component.index"]) {
  try {
    indexComp = new Contract(await compAddr(guess), COMP_ABI, provider);
    console.log(`(index component: ${guess})`);
    break;
  } catch {}
}

console.log(`watching market account ${MARKET_ACC_ID} for incoming kamis…`);
for (;;) {
  try {
    const kamis = await idOwnsKami.getEntitiesWithValue(MARKET_ACC_ID);
    if (kamis.length > 0) {
      for (const k of kamis) {
        let idx = "?";
        if (indexComp) {
          try { idx = (await indexComp.getValue(k)).toString(); } catch {}
        }
        console.log(`KAMI ARRIVED: entity=${k.toString()} tokenIndex=${idx}`);
      }
      process.exit(0);
    }
  } catch (e) {
    // transient RPC hiccup — keep watching
  }
  await new Promise((r) => setTimeout(r, 30_000));
}
