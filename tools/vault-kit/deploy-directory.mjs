#!/usr/bin/env node
// Deploy the PoolDirectory (the PaaS storefront index) and list the two
// flagship pools. Idempotent via directory-deployment.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, ContractFactory, JsonRpcProvider, Wallet } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const vippEnv = Object.fromEntries(
  readFileSync(resolve(here, "../vault-kit-vipp/.env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const provider = new JsonRpcProvider(env.YOMINET_RPC);
const deployer = new Wallet(env.DEPLOYER_KEY, provider);
const artifact = JSON.parse(
  readFileSync(
    resolve(here, "../../packages/contracts/out/PoolDirectory.sol/PoolDirectory.json"),
    "utf8"
  )
);

const statePath = join(here, "directory-deployment.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

if (!state.address || (await provider.getCode(state.address)) === "0x") {
  const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, deployer);
  const dir = await factory.deploy();
  await dir.waitForDeployment();
  state.address = await dir.getAddress();
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log("PoolDirectory deployed:", state.address);
} else {
  console.log("PoolDirectory exists:", state.address);
}

const dir = new Contract(
  state.address,
  [
    "function add(address hub, address podRegistry, address selfRegistry, string label)",
    "function count() view returns (uint256)",
    "function all() view returns (tuple(address hub, address podRegistry, address selfRegistry, string label)[])",
  ],
  deployer
);

const ZERO = "0x0000000000000000000000000000000000000000";
const wanted = [
  {
    hub: env.MARKET_ADDRESS,
    reg: env.REGISTRY_ADDRESS,
    self: env.SELF_REGISTRY_ADDRESS || ZERO,
    label: "Flagship MUSU pool",
  },
  {
    hub: vippEnv.MARKET_ADDRESS,
    reg: vippEnv.REGISTRY_ADDRESS,
    self: ZERO,
    label: "Flagship VIPP pool",
  },
];
const listed = new Set((await dir.all()).map((r) => r.hub.toLowerCase()));
for (const w of wanted) {
  if (listed.has(w.hub.toLowerCase())) {
    console.log("already listed:", w.label);
    continue;
  }
  await (await dir.add(w.hub, w.reg, w.self, w.label)).wait();
  console.log("listed:", w.label, w.hub);
}
console.log("directory count:", await dir.count());
console.log(`ENV: NEXT_PUBLIC_POOL_DIRECTORY_ADDRESS=${state.address}`);
