// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IWorld} from "solecs/interfaces/IWorld.sol";
import {IUint256Component as IUintComp} from "solecs/interfaces/IUint256Component.sol";

import {LibConfig} from "libraries/LibConfig.sol";
import {Kami721} from "tokens/Kami721.sol";
import {HubGuard} from "vault/HubGuard.sol";
import {KamiLeaseMarket} from "vault/KamiLeaseMarket.sol";
import {PersonalRentalPool} from "vault/PersonalRentalPool.sol";
import {PersonalRentalPoolRegistry} from "vault/PersonalRentalPoolRegistry.sol";
import {PersonalRentalVaultFactory} from "vault/PersonalRentalVaultFactory.sol";
import {RenterRoomPodFactory} from "vault/RenterRoomPodFactory.sol";

/**
 * @notice Staged single-currency developer deployment. Production should use
 * DeployDualKamiLeaseMarket so MUSU/VIPP share one registry and vault factory.
 * Separate broadcasts avoid oversized initcode; addresses are usable only
 * after the market and registry are both sealed.
 */
contract DeployKamiLeaseMarket is Script {
    function run() external {
        IWorld world = IWorld(vm.envAddress("WORLD_ADDR"));
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address quoteSigner = vm.envAddress("QUOTE_SIGNER");
        address keeper = vm.envAddress("MARKET_KEEPER");
        address settler = vm.envAddress("MARKET_SETTLER");
        string memory name = vm.envString("MARKET_NAME");
        uint32 payItem = uint32(vm.envUint("PAY_ITEM"));
        uint256 mgmtAccID = vm.envUint("MGMT_ACC_ID");
        require(payItem == 1 || payItem == 2, "PAY_ITEM must be MUSU(1) or VIPP(2)");
        require(quoteSigner != keeper, "quote signer equals keeper");

        address kami721Addr = vm.envOr("KAMI721_ADDR", address(0));
        if (kami721Addr == address(0)) {
            IUintComp comps = world.components();
            kami721Addr = LibConfig.getAddress(comps, "KAMI721_ADDRESS");
        }
        require(kami721Addr != address(0), "Kami721 address not found");

        vm.startBroadcast();
        PersonalRentalPoolRegistry registry = new PersonalRentalPoolRegistry(deployer);
        KamiLeaseMarket market = new KamiLeaseMarket(world, Kami721(kami721Addr), 1_000, payItem);
        RenterRoomPodFactory renterFactory =
            new RenterRoomPodFactory(world, address(market), quoteSigner, keeper);
        HubGuard guard = new HubGuard(world, address(market), address(renterFactory));
        market.initialize(address(guard), name);
        market.setSettler(settler);
        market.setMgmtAccount(mgmtAccID);
        market.setLeaseFactory(address(renterFactory));
        market.setPoolRegistry(address(registry));
        market.sealAdmin();
        PersonalRentalPool poolImplementation = new PersonalRentalPool();
        PersonalRentalVaultFactory vaultFactory = new PersonalRentalVaultFactory(
            world,
            address(poolImplementation),
            payItem == 1 ? address(market) : address(0),
            payItem == 2 ? address(market) : address(0),
            address(registry)
        );
        registry.setFactory(address(vaultFactory));
        vm.stopBroadcast();

        require(market.admin() == address(0), "market not sealed");
        require(registry.installer() == address(0), "registry not sealed");
        console.log("KamiLeaseMarket:", address(market));
        console.log("RenterRoomPodFactory:", address(renterFactory));
        console.log("HubGuard:", address(guard));
        console.log("PersonalRentalPoolRegistry:", address(registry));
        console.log("PersonalRentalVaultFactory:", address(vaultFactory));
    }
}
