// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import { Script, console } from "forge-std/Script.sol";
import { IWorld } from "solecs/interfaces/IWorld.sol";
import { IUint256Component as IUintComp } from "solecs/interfaces/IUint256Component.sol";

import { LibConfig } from "libraries/LibConfig.sol";
import { Kami721 } from "tokens/Kami721.sol";
import { KamiLeaseMarket } from "vault/KamiLeaseMarket.sol";

/**
 * Deploys KamiLeaseMarket against a live World (Yominet or local anvil).
 *
 * Env:
 *  WORLD_ADDR       — World (Yominet: 0x2729174c265dbBd8416C6449E0E813E88f43D0E7)
 *  MARKET_OPERATOR  — fresh operator EOA (key goes to Kamibots ONLY)
 *  MARKET_NAME      — game account name, <=16 chars, unused
 *  MGMT_BPS         — platform fee bps (max 3000)
 *  KAMI721_ADDR     — optional override; else resolved from on-chain config
 *
 * forge script script/DeployKamiLeaseMarket.s.sol:DeployKamiLeaseMarket \
 *   --rpc-url https://jsonrpc-yominet-1.anvil.asia-southeast.initia.xyz \
 *   --broadcast --private-key $DEPLOYER_KEY
 */
contract DeployKamiLeaseMarket is Script {
  function run() external {
    IWorld world = IWorld(vm.envAddress("WORLD_ADDR"));
    address operator = vm.envAddress("MARKET_OPERATOR");
    string memory name = vm.envString("MARKET_NAME");
    uint16 mgmtBps = uint16(vm.envUint("MGMT_BPS"));

    address kami721Addr = vm.envOr("KAMI721_ADDR", address(0));
    if (kami721Addr == address(0)) {
      IUintComp comps = world.components();
      kami721Addr = LibConfig.getAddress(comps, "KAMI721_ADDRESS");
    }
    require(kami721Addr != address(0), "Kami721 address not found");

    vm.startBroadcast();
    KamiLeaseMarket market = new KamiLeaseMarket(world, Kami721(kami721Addr), mgmtBps);
    market.initialize(operator, name);
    vm.stopBroadcast();

    console.log("KamiLeaseMarket:", address(market));
    console.log("game accID:", market.accID());
    console.log("operator:", operator);
    console.log("kami721:", kami721Addr);
  }
}
