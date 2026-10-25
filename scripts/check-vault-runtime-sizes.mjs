#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TARGETS = ["KamiLeaseMarket", "RenterRoomPodFactory", "RoomPod", "HubGuard", "PodRecoveryOperator", "PersonalRentalPoolRegistry", "PersonalRentalPool", "PersonalRentalVault", "PersonalRentalVaultFactory"];
export function validateArtifact(name, artifact) {
  const settings = artifact.metadata?.settings;
  if (artifact.metadata?.compiler?.version !== "0.8.28+commit.7893614a" ||
      settings?.viaIR !== true || settings?.optimizer?.enabled !== true ||
      settings?.optimizer?.runs !== 1 || settings?.evmVersion !== "prague") {
    throw new Error(`${name}: not the pinned production v17 compiler profile`);
  }
  const size = (code) => {
    if (typeof code !== "string" || !/^0x(?:[a-fA-F0-9]{2})+$/.test(code)) throw new Error(`${name}: missing or unlinked bytecode`);
    return (code.length - 2) / 2;
  };
  const runtimeBytes = size(artifact.deployedBytecode?.object);
  const creationBytes = size(artifact.bytecode?.object);
  if (runtimeBytes > 24_576) throw new Error(`${name}: runtime ${runtimeBytes} exceeds EIP-170`);
  if (creationBytes > 49_152) throw new Error(`${name}: creation bytecode ${creationBytes} exceeds EIP-3860 before constructor args`);
  return { name, runtimeBytes, runtimeHeadroom: 24_576 - runtimeBytes, creationBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const contracts = join(root, "packages/contracts");
  const { keccak256 } = createRequire(join(root, "tools/vault-kit/package.json"))("ethers");
  for (const name of TARGETS) {
    const artifact = JSON.parse(readFileSync(join(contracts, "out-v17", `${name}.sol`, `${name}.json`), "utf8"));
    const result = validateArtifact(name, artifact);
    const sources = Object.entries(artifact.metadata?.sources ?? {}).filter(([path]) => path.startsWith("src/vault/"));
    if (!sources.length) throw new Error(`${name}: missing vault source provenance`);
    for (const [path, source] of sources) {
      if (path.split("/").includes("..")) throw new Error("Invalid artifact source path");
      if (keccak256(readFileSync(join(contracts, path))) !== source.keccak256) throw new Error(`${name}: stale artifact for ${path}`);
    }
    console.log(JSON.stringify({ ...result, vaultSourcesVerified: sources.length }));
  }
  console.log("Size/profile/source gate passed. Constructor arguments, chain support, wiring, and live deployment simulation remain separate gates.");
}
