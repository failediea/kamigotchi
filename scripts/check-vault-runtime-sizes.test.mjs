import test from "node:test";
import assert from "node:assert/strict";
import { validateArtifact } from "./check-vault-runtime-sizes.mjs";

function artifact(runtime = 24_576, creation = 49_152) {
  return {
    metadata: { compiler: { version: "0.8.28+commit.7893614a" }, settings: { viaIR: true, optimizer: { enabled: true, runs: 1 }, evmVersion: "prague" } },
    deployedBytecode: { object: "0x" + "00".repeat(runtime) },
    bytecode: { object: "0x" + "00".repeat(creation) },
  };
}
test("checks exact runtime and creation boundaries independently of forge exit status", () => {
  assert.equal(validateArtifact("test", artifact()).runtimeHeadroom, 0);
  assert.throws(() => validateArtifact("test", artifact(24_577)), /EIP-170/);
  assert.throws(() => validateArtifact("test", artifact(10, 49_153)), /EIP-3860/);
});
test("rejects a test profile, missing metadata, and unresolved library bytecode", () => {
  const a = artifact(); a.metadata.settings.optimizer.runs = 200;
  assert.throws(() => validateArtifact("test", a), /profile/);
  assert.throws(() => validateArtifact("test", {}), /profile/);
  const b = artifact(); b.deployedBytecode.object = "0x__library__";
  assert.throws(() => validateArtifact("test", b), /unlinked/);
});
