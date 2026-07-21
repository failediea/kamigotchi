// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IWorld} from "solecs/interfaces/IWorld.sol";
import {PersonalRentalPool} from "vault/PersonalRentalPool.sol";
import {PersonalRentalVaultFactory} from "vault/PersonalRentalVaultFactory.sol";

/**
 * Deploys the permissionless Personal Rental Vault factory after the MUSU and
 * VIPP markets have been configured and permanently sealed.
 *
 * Env:
 *  WORLD_ADDR   Yominet World
 *  MUSU_MARKET  sealed KamiLeaseMarket with payItem=1 and mgmtBps=1000
 *  VIPP_MARKET  sealed KamiLeaseMarket with payItem=2 and mgmtBps=1000
 *
 * The deployer receives no role. Owners pay their own vault/pool deployment gas.
 */
contract DeployPersonalRentalVaultFactory is Script {
    function run() external {
        IWorld world = IWorld(vm.envAddress("WORLD_ADDR"));
        address musuMarket = vm.envAddress("MUSU_MARKET");
        address vippMarket = vm.envAddress("VIPP_MARKET");

        vm.startBroadcast();
        PersonalRentalPool poolImplementation = new PersonalRentalPool();
        PersonalRentalVaultFactory factory =
            new PersonalRentalVaultFactory(world, address(poolImplementation), musuMarket, vippMarket);
        vm.stopBroadcast();

        console.log("PersonalRentalVaultFactory:", address(factory));
        console.log("PersonalRentalPool implementation:", factory.poolImplementation());
        console.log("MUSU market:", factory.musuMarket());
        console.log("VIPP market:", factory.vippMarket());
        console.log("Platform account ID:", factory.platformAccID());
        console.log("Platform fee bps:", factory.PLATFORM_FEE_BPS());
        console.log("No deployer/admin role was created.");
    }
}
