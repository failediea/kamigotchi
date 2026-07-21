// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IWorld} from "solecs/interfaces/IWorld.sol";
import {IUint256Component as IUintComp} from "solecs/interfaces/IUint256Component.sol";

import {LibConfig} from "libraries/LibConfig.sol";
import {Kami721} from "tokens/Kami721.sol";
import {KamiLeaseMarket} from "vault/KamiLeaseMarket.sol";
import {RenterRoomPodFactory} from "vault/RenterRoomPodFactory.sol";

/// @dev The market is born and sealed inside this constructor, so there is no
/// block where a configured market exists with a usable admin. This wrapper
/// retains only a public pointer to the sealed market and has no control over it.
contract AtomicKamiLeaseMarketDeployment {
    KamiLeaseMarket public immutable market;
    RenterRoomPodFactory public immutable renterPodFactory;

    constructor(
        IWorld world,
        Kami721 kami721,
        address operator,
        address settler,
        string memory name,
        uint32 payItem,
        uint256 mgmtAccID
    ) {
        market = new KamiLeaseMarket(world, kami721, 1_000, payItem);
        market.initialize(operator, name);
        market.setSettler(settler);
        market.setMgmtAccount(mgmtAccID);
        renterPodFactory = new RenterRoomPodFactory(world, address(market), operator);
        market.setLeaseFactory(address(renterPodFactory));
        market.sealAdmin();
        require(market.admin() == address(0), "market not sealed");
    }
}

/**
 * Deploys, fully configures, and permanently seals one currency market.
 * Run once with PAY_ITEM=1 for MUSU and once with PAY_ITEM=2 for VIPP.
 *
 * Env:
 *  WORLD_ADDR       Yominet World
 *  MARKET_OPERATOR  existing hub operator used by the platform ops bot
 *  MARKET_SETTLER   daily accounting/finalization keeper
 *  The MARKET_OPERATOR is also the fixed provisioning quote signer. Renter
 *  checkout funds its prepare/send/activate transactions directly.
 *  MARKET_NAME      game account name, <=16 chars
 *  MGMT_ACC_ID      canzi#200 game account ID receiving the 10% fee
 *  PAY_ITEM         1 (MUSU) or 2 (VIPP)
 *  KAMI721_ADDR     optional override; otherwise resolved on-chain
 *
 * sealAdmin() is called inside the same transaction that creates the market. After it succeeds there
 * is no operator rotation, fee change, management-account change, pause, rescue,
 * upgrade, or emergency admin path.
 */
contract DeployKamiLeaseMarket is Script {
    uint16 internal constant PLATFORM_FEE_BPS = 1_000;

    function run() external {
        IWorld world = IWorld(vm.envAddress("WORLD_ADDR"));
        address operator = vm.envAddress("MARKET_OPERATOR");
        address settler = vm.envAddress("MARKET_SETTLER");
        string memory name = vm.envString("MARKET_NAME");
        uint32 payItem = uint32(vm.envUint("PAY_ITEM"));
        uint256 mgmtAccID = vm.envUint("MGMT_ACC_ID");
        require(payItem == 1 || payItem == 2, "PAY_ITEM must be MUSU(1) or VIPP(2)");

        address kami721Addr = vm.envOr("KAMI721_ADDR", address(0));
        if (kami721Addr == address(0)) {
            IUintComp comps = world.components();
            kami721Addr = LibConfig.getAddress(comps, "KAMI721_ADDRESS");
        }
        require(kami721Addr != address(0), "Kami721 address not found");

        vm.startBroadcast();
        AtomicKamiLeaseMarketDeployment deployment = new AtomicKamiLeaseMarketDeployment(
            world, Kami721(kami721Addr), operator, settler, name, payItem, mgmtAccID
        );
        vm.stopBroadcast();
        KamiLeaseMarket market = deployment.market();

        console.log("KamiLeaseMarket:", address(market));
        console.log("RenterRoomPodFactory:", address(deployment.renterPodFactory()));
        console.log("game accID:", market.accID());
        console.log("operator:", operator);
        console.log("daily settler:", settler);
        console.log("pay item:", payItem);
        console.log("platform fee bps:", PLATFORM_FEE_BPS);
        console.log("admin permanently sealed:", market.admin());
    }
}
