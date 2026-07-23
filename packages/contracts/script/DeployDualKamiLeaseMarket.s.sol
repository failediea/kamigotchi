// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IWorld} from "solecs/interfaces/IWorld.sol";
import {IUint256Component as IUintComp} from "solecs/interfaces/IUint256Component.sol";

import {LibConfig} from "libraries/LibConfig.sol";
import {Kami721} from "tokens/Kami721.sol";
import {BatchLease} from "vault/BatchLease.sol";
import {HubGuard} from "vault/HubGuard.sol";
import {KamiLeaseMarket} from "vault/KamiLeaseMarket.sol";
import {PersonalRentalPool} from "vault/PersonalRentalPool.sol";
import {PersonalRentalPoolRegistry} from "vault/PersonalRentalPoolRegistry.sol";
import {PersonalRentalVaultFactory} from "vault/PersonalRentalVaultFactory.sol";
import {RenterRoomPodFactory} from "vault/RenterRoomPodFactory.sol";

/**
 * @notice Coordinated deployment of both markets and one shared owner-vault
 * factory. Child contracts are broadcast as separate transactions so no
 * creation transaction exceeds EIP-3860. The script does not publish addresses
 * until both markets and the registry have burned their temporary installer.
 * If a transaction fails, the partial deployment has no registered pools and
 * must not be wired into Kamistats.
 */
contract DeployDualKamiLeaseMarket is Script {
    function run() external {
        IWorld world = IWorld(vm.envAddress("WORLD_ADDR"));
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address quoteSigner = vm.envAddress("QUOTE_SIGNER");
        address keeper = vm.envAddress("MARKET_KEEPER");
        address settler = vm.envAddress("MARKET_SETTLER");
        uint256 mgmtAccID = vm.envUint("MGMT_ACC_ID");
        string memory musuName = vm.envString("MUSU_MARKET_NAME");
        string memory vippName = vm.envString("VIPP_MARKET_NAME");
        require(quoteSigner != keeper, "quote signer equals keeper");

        address kami721Addr = vm.envOr("KAMI721_ADDR", address(0));
        if (kami721Addr == address(0)) {
            IUintComp comps = world.components();
            kami721Addr = LibConfig.getAddress(comps, "KAMI721_ADDRESS");
        }
        require(kami721Addr != address(0), "Kami721 address not found");

        vm.startBroadcast();
        PersonalRentalPoolRegistry registry = new PersonalRentalPoolRegistry(deployer);
        KamiLeaseMarket musuMarket = new KamiLeaseMarket(world, Kami721(kami721Addr), 1_000, 1);
        KamiLeaseMarket vippMarket = new KamiLeaseMarket(world, Kami721(kami721Addr), 1_000, 2);
        RenterRoomPodFactory musuRenterFactory =
            new RenterRoomPodFactory(world, address(musuMarket), quoteSigner, keeper);
        RenterRoomPodFactory vippRenterFactory =
            new RenterRoomPodFactory(world, address(vippMarket), quoteSigner, keeper);
        HubGuard musuHubGuard = new HubGuard(world, address(musuMarket), address(musuRenterFactory));
        HubGuard vippHubGuard = new HubGuard(world, address(vippMarket), address(vippRenterFactory));

        _configureAndSeal(
            musuMarket,
            musuRenterFactory,
            musuHubGuard,
            address(registry),
            settler,
            musuName,
            mgmtAccID
        );
        _configureAndSeal(
            vippMarket,
            vippRenterFactory,
            vippHubGuard,
            address(registry),
            settler,
            vippName,
            mgmtAccID
        );

        PersonalRentalPool poolImplementation = new PersonalRentalPool();
        PersonalRentalVaultFactory personalVaultFactory = new PersonalRentalVaultFactory(
            world,
            address(poolImplementation),
            address(musuMarket),
            address(vippMarket),
            address(registry)
        );
        registry.setFactory(address(personalVaultFactory));
        BatchLease musuBatchLease = new BatchLease(musuRenterFactory);
        BatchLease vippBatchLease = new BatchLease(vippRenterFactory);
        vm.stopBroadcast();

        require(musuMarket.admin() == address(0) && vippMarket.admin() == address(0), "market admin live");
        require(registry.installer() == address(0), "registry installer live");
        console.log("MUSU market:", address(musuMarket));
        console.log("VIPP market:", address(vippMarket));
        console.log("MUSU renter factory:", address(musuRenterFactory));
        console.log("VIPP renter factory:", address(vippRenterFactory));
        console.log("MUSU HubGuard:", address(musuHubGuard));
        console.log("VIPP HubGuard:", address(vippHubGuard));
        console.log("Pool registry:", address(registry));
        console.log("Personal vault factory:", address(personalVaultFactory));
        console.log("MUSU BatchLease:", address(musuBatchLease));
        console.log("VIPP BatchLease:", address(vippBatchLease));
    }

    function _configureAndSeal(
        KamiLeaseMarket market,
        RenterRoomPodFactory renterFactory,
        HubGuard guard,
        address registry,
        address settler,
        string memory name,
        uint256 mgmtAccID
    ) internal {
        market.initialize(address(guard), name);
        market.setSettler(settler);
        market.setMgmtAccount(mgmtAccID);
        market.setLeaseFactory(address(renterFactory));
        market.setPoolRegistry(registry);
        market.sealAdmin();
    }
}
