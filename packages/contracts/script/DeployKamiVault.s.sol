// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import { Script, console } from "forge-std/Script.sol";
import { IWorld } from "solecs/interfaces/IWorld.sol";
import { IUint256Component as IUintComp } from "solecs/interfaces/IUint256Component.sol";

import { LibConfig } from "libraries/LibConfig.sol";
import { Kami721 } from "tokens/Kami721.sol";
import { KamiVault } from "vault/KamiVault.sol";

/**
 * Deploys a KamiVault against a live World (Yominet or local anvil).
 *
 * Env:
 *  WORLD_ADDR       — World contract (Yominet: 0x2729174c265dbBd8416C6449E0E813E88f43D0E7)
 *  VAULT_OPERATOR   — fresh operator EOA for this vault (key goes to Kamibots ONLY)
 *  VAULT_NAME       — game account name, <=16 chars, must be unused
 *  MGMT_BPS         — management fee in bps (e.g. 1500 = 15%)
 *  KAMI721_ADDR     — optional override; otherwise resolved from on-chain config
 *
 * Run (Yominet):
 *  forge script script/DeployKamiVault.s.sol:DeployKamiVault \
 *    --rpc-url https://jsonrpc-yominet-1.anvil.asia-southeast.initia.xyz \
 *    --broadcast --private-key $DEPLOYER_KEY
 *
 * NOTE: the deployer key becomes the vault ADMIN. Use a throwaway for the go/no-go
 * test; a hardware/multisig-controlled key for production.
 */
contract DeployKamiVault is Script {
  function run() external {
    IWorld world = IWorld(vm.envAddress("WORLD_ADDR"));
    address operator = vm.envAddress("VAULT_OPERATOR");
    string memory name = vm.envString("VAULT_NAME");
    uint16 mgmtBps = uint16(vm.envUint("MGMT_BPS"));

    // resolve Kami721 from on-chain config unless overridden
    address kami721Addr = vm.envOr("KAMI721_ADDR", address(0));
    if (kami721Addr == address(0)) {
      IUintComp comps = world.components();
      kami721Addr = LibConfig.getAddress(comps, "KAMI721_ADDRESS");
    }
    require(kami721Addr != address(0), "Kami721 address not found");

    vm.startBroadcast();
    KamiVault vault = new KamiVault(world, Kami721(kami721Addr), mgmtBps);
    vault.initialize(operator, name);
    vm.stopBroadcast();

    console.log("KamiVault:", address(vault));
    console.log("game accID:", vault.accID());
    console.log("operator:", operator);
    console.log("kami721:", kami721Addr);
  }
}
