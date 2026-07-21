// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import "tests/utils/SetupTemplate.t.sol";
import {PersonalRentalPool} from "vault/PersonalRentalPool.sol";
import {PersonalRentalVault} from "vault/PersonalRentalVault.sol";
import {PersonalRentalVaultFactory} from "vault/PersonalRentalVaultFactory.sol";
import {KamiLeaseMarket} from "vault/KamiLeaseMarket.sol";
import {RenterRoomPodFactory} from "vault/RenterRoomPodFactory.sol";
import {RoomPod} from "vault/RoomPod.sol";

/**
 * End-to-end tests for owner-specific idle custody feeding the existing managed
 * hub/RoomPod/Kamibots market. No owner or renter key is ever registered here.
 */
contract PersonalRentalVaultTest is SetupTemplate {
    KamiLeaseMarket market;
    PersonalRentalVaultFactory factory;
    PersonalRentalVault vault;
    PersonalRentalPool pool;
    RenterRoomPodFactory renterPodFactory;
    address marketOperator;
    address lastPod;
    address lastPodOperator;

    uint256 constant PROVISIONING_SIGNER_KEY = 0xA11CE;
    uint128 constant SETUP_GAS = 0.001 ether;
    uint128 constant HUB_GAS = 0.0005 ether;
    uint128 constant OPERATING_GAS = 0.002 ether;

    uint16 constant PLATFORM_BPS = 1_000;
    uint16 constant OWNER_BPS = 3_000;

    function setUp() public override {
        super.setUp();
        marketOperator = vm.addr(PROVISIONING_SIGNER_KEY);

        market = new KamiLeaseMarket(world, _Kami721, PLATFORM_BPS, MUSU_INDEX);
        market.initialize(marketOperator, "leasehub");
        market.setSettler(address(this));
        market.setMgmtAccount(charlie.id);
        renterPodFactory = new RenterRoomPodFactory(
            world, address(market), vm.addr(PROVISIONING_SIGNER_KEY)
        );
        market.setLeaseFactory(address(renterPodFactory));
        market.sealAdmin();

        PersonalRentalPool implementation = new PersonalRentalPool();
        factory = new PersonalRentalVaultFactory(
            world, address(implementation), address(market), address(0)
        );

        vm.prank(alice.owner);
        vault = PersonalRentalVault(factory.createVault("Alice rental vault"));
        vm.prank(alice.owner);
        pool = PersonalRentalPool(
            vault.createPool(address(market), OWNER_BPS, 7 days, "alicepool")
        );

        vm.startPrank(deployer);
        _TimeComponent.authorizeWriter(address(_HarvestStartSystem));
        _TimeComponent.authorizeWriter(address(_HarvestCollectSystem));
        _TimeComponent.authorizeWriter(address(_HarvestStopSystem));
        vm.stopPrank();
    }

    function _listAndPublish() internal returns (uint256 kamiID, uint32 tokenIndex) {
        kamiID = _mintKami(alice);
        tokenIndex = LibKami.getIndex(components, kamiID);

        vm.prank(alice.owner);
        pool.declareKami(tokenIndex);
        vm.prank(alice.operator);
        _KamiSendSystem.executeTyped(tokenIndex, address(pool));
        vm.prank(alice.owner);
        pool.confirmAndPublish(tokenIndex, address(0));
        _fastForward(2 hours); // clear owner -> pool KamiSend cooldown
    }

    function _quote(uint32 tokenIndex, address renter, address podOperator)
        internal
        view
        returns (RenterRoomPodFactory.Quote memory quote)
    {
        quote = RenterRoomPodFactory.Quote({
            renter: renter,
            tokenIndex: tokenIndex,
            nodeIndex: 1,
            operator: podOperator,
            expectedOwnerShareBps: OWNER_BPS,
            termSecs: 1 days,
            setupGasWei: SETUP_GAS,
            hubGasWei: HUB_GAS,
            operatingGasWei: OPERATING_GAS,
            deadline: uint64(block.timestamp + 1 hours),
            nonce: keccak256(abi.encode(tokenIndex, renter, podOperator)),
            label: "Misty Riverside (EERIE)",
            accountName: "rentertestpod",
            prefs: '{"node":1,"risk":"balanced"}'
        });
    }

    function _signQuote(RenterRoomPodFactory.Quote memory quote) internal returns (bytes memory) {
        bytes32 digest = renterPodFactory.quoteDigest(quote);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PROVISIONING_SIGNER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _request(uint32 tokenIndex) internal returns (address podAddress) {
        lastPodOperator = _getNextUserAddress();
        RenterRoomPodFactory.Quote memory quote = _quote(tokenIndex, bob.owner, lastPodOperator);
        bytes memory signature = _signQuote(quote);
        vm.deal(bob.owner, SETUP_GAS + HUB_GAS + OPERATING_GAS);
        vm.prank(bob.owner);
        podAddress = renterPodFactory.createPodAndRequestLease{
            value: SETUP_GAS + HUB_GAS + OPERATING_GAS
        }(quote, signature);
        lastPod = podAddress;
    }

    function _accept(uint32 tokenIndex) internal {
        _request(tokenIndex);
        vm.prank(vm.addr(PROVISIONING_SIGNER_KEY));
        renterPodFactory.markLeasePreparing(tokenIndex);
        _fastForward(2 hours);
        vm.prank(marketOperator);
        _KamiSendSystem.executeTyped(tokenIndex, lastPodOperator);
        _fastForward(2 hours);
        vm.prank(vm.addr(PROVISIONING_SIGNER_KEY));
        renterPodFactory.activateProvisionedLease(tokenIndex);
    }

    function _harvestInHub(uint256 kamiID, uint256 bounty) internal {
        _fastForward(12 hours); // clear the preceding pool -> hub send cooldown
        vm.prank(lastPodOperator);
        bytes memory raw = _HarvestStartSystem.executeTyped(kamiID, 1, 0, 0);
        uint256 harvestID = abi.decode(raw, (uint256));
        _incHarvestBounty(harvestID, bounty);
        _fastForward(_idleRequirement);
        vm.prank(lastPodOperator);
        _HarvestStopSystem.executeTyped(harvestID);
    }

    function testFactoryVaultAndPoolHaveNoAdminOrKeeperSurface() public view {
        assertEq(market.admin(), address(0), "market admin permanently sealed");
        assertEq(factory.vaultOf(alice.owner), address(vault));
        assertEq(vault.owner(), alice.owner);
        assertTrue(vault.isPool(address(pool)));
        assertEq(pool.vaultOwner(), alice.owner);
        assertEq(pool.market(), address(market));
        assertEq(pool.operatorAddr(), address(pool));
        assertEq(pool.accID(), uint256(uint160(address(pool))));
        assertEq(factory.PLATFORM_FEE_BPS(), PLATFORM_BPS);

        (bool factoryAdmin,) = address(factory).staticcall(abi.encodeWithSignature("admin()"));
        (bool vaultAdmin,) = address(vault).staticcall(abi.encodeWithSignature("admin()"));
        (bool poolAdmin,) = address(pool).staticcall(abi.encodeWithSignature("admin()"));
        (bool poolKeeper,) = address(pool).staticcall(abi.encodeWithSignature("keeper()"));
        assertFalse(factoryAdmin || vaultAdmin || poolAdmin || poolKeeper, "no hidden authority surface");
    }

    function testFactoryRejectsUnsealedMarket() public {
        KamiLeaseMarket unsealed = new KamiLeaseMarket(world, _Kami721, PLATFORM_BPS, MUSU_INDEX);
        unsealed.initialize(_getNextUserAddress(), "unsealed");
        unsealed.setSettler(address(this));
        unsealed.setMgmtAccount(charlie.id);
        PersonalRentalPool implementation = new PersonalRentalPool();
        vm.expectRevert(PersonalRentalVaultFactory.MarketNotSealed.selector);
        new PersonalRentalVaultFactory(world, address(implementation), address(unsealed), address(0));
    }

    function testFirstVaultAndPoolCanBeCreatedInOneOwnerTransaction() public {
        address owner2 = _getNextUserAddress();
        vm.prank(owner2);
        (address vault2, address pool2) = factory.createVaultWithPool(
            "Second owner", address(market), 4_000, 5 days, "owner2pool"
        );
        assertEq(factory.vaultOf(owner2), vault2);
        assertTrue(PersonalRentalVault(vault2).isPool(pool2));
        assertEq(PersonalRentalPool(pool2).vaultOwner(), owner2);
    }

    function testIdleKamiStaysInOwnerPoolUntilRented() public {
        (uint256 kamiID, uint32 tokenIndex) = _listAndPublish();
        assertEq(LibKami.getAccount(components, kamiID), pool.accID(), "idle custody is owner's pool");
        assertEq(market.listings(tokenIndex).owner, address(pool), "pool is the on-chain return target");
        assertEq(market.listingBeneficiary(tokenIndex), alice.owner, "owner receives marketplace proceeds");
        assertFalse(market.listings(tokenIndex).staked, "not in platform hub yet");

        vm.prank(marketOperator);
        vm.expectRevert();
        _KamiSendSystem.executeTyped(tokenIndex, bob.operator);
        assertEq(LibKami.getAccount(components, kamiID), pool.accID(), "hub key cannot touch idle custody");

        vm.prank(bob.owner);
        vm.expectRevert(PersonalRentalPool.NotMarket.selector);
        pool.releaseToMarket(tokenIndex);
    }

    function testOnlyOwnerCanPublishPoolTerms() public {
        uint256 kamiID = _mintKami(alice);
        uint32 tokenIndex = LibKami.getIndex(components, kamiID);
        vm.prank(alice.owner);
        pool.declareKami(tokenIndex);
        vm.prank(alice.operator);
        _KamiSendSystem.executeTyped(tokenIndex, address(pool));

        vm.prank(bob.owner);
        vm.expectRevert(PersonalRentalPool.NotOwner.selector);
        pool.confirmAndPublish(tokenIndex, bob.owner);

        vm.prank(alice.owner);
        pool.confirmAndPublish(tokenIndex, address(0));
        assertEq(market.listingBeneficiary(tokenIndex), alice.owner);
    }

    function testRenterFundsPodAndClockStartsOnlyAfterActivation() public {
        (uint256 kamiID, uint32 tokenIndex) = _listAndPublish();
        _request(tokenIndex);

        (
            address pendingRenter,
            address pendingPod,
            uint256 pendingGas,
            ,
            ,
            uint8 pendingStage
        ) = renterPodFactory.requests(tokenIndex);
        assertEq(pendingRenter, bob.owner);
        assertEq(pendingPod, lastPod);
        assertEq(pendingGas, OPERATING_GAS);
        assertEq(pendingStage, 1);
        assertEq(market.listings(tokenIndex).leaseStart, 0, "setup time is not rental time");
        assertEq(lastPodOperator.balance, SETUP_GAS, "renter funded pod walking gas");
        assertEq(marketOperator.balance, HUB_GAS, "renter funded the hub shipping transaction");
        assertEq(address(renterPodFactory).balance, OPERATING_GAS, "factory escrows renter farming gas");
        assertEq(address(market).balance, 0, "market never holds renter ETH");

        vm.prank(vm.addr(PROVISIONING_SIGNER_KEY));
        renterPodFactory.markLeasePreparing(tokenIndex);
        assertEq(LibKami.getAccount(components, kamiID), market.accID(), "preparing Kami reached hub");
        assertEq(market.listings(tokenIndex).leaseStart, 0, "clock remains stopped in transit");

        _fastForward(2 hours);
        vm.prank(marketOperator);
        _KamiSendSystem.executeTyped(tokenIndex, lastPodOperator);
        _fastForward(2 hours);
        uint256 activatedAt = block.timestamp;
        vm.prank(vm.addr(PROVISIONING_SIGNER_KEY));
        renterPodFactory.activateProvisionedLease(tokenIndex);

        assertEq(LibKami.getAccount(components, kamiID), RoomPod(lastPod).accID(), "accepted Kami reached its pod");
        KamiLeaseMarket.Listing memory listing = market.listings(tokenIndex);
        assertTrue(listing.staked);
        assertEq(listing.renter, bob.owner);
        assertEq(listing.gasBudget, 0, "market does not custody renter ETH");
        assertEq(listing.leaseStart, activatedAt, "paid clock begins at activation");
        assertEq(listing.leaseEnd, activatedAt + 1 days);
    }

    function testExistingPlatformOperatorCanRouteAndFarmAcceptedKami() public {
        (uint256 kamiID, uint32 tokenIndex) = _listAndPublish();
        _accept(tokenIndex);

        assertEq(LibKami.getAccount(components, kamiID), RoomPod(lastPod).accID(), "routed to renter-funded pod");
        vm.prank(lastPodOperator);
        bytes memory raw = _HarvestStartSystem.executeTyped(kamiID, 1, 0, 0);
        uint256 harvestID = abi.decode(raw, (uint256));
        _incHarvestBounty(harvestID, 100_000);
        _fastForward(_idleRequirement);
        vm.prank(lastPodOperator);
        _HarvestStopSystem.executeTyped(harvestID);
        assertGt(LibExperience.get(components, kamiID), 0, "pod operator produced attributable XP");
    }

    function testOnlyDedicatedPodOperatorCanPullRenterGas() public {
        (, uint32 tokenIndex) = _listAndPublish();
        _accept(tokenIndex);

        vm.prank(bob.owner);
        vm.expectRevert(RenterRoomPodFactory.NotOperator.selector);
        renterPodFactory.pullGas(tokenIndex, 0.0005 ether);

        uint256 before = lastPodOperator.balance;
        vm.prank(lastPodOperator);
        renterPodFactory.pullGas(tokenIndex, 0.0005 ether);
        assertEq(lastPodOperator.balance, before + 0.0005 ether);
        (,, uint256 remaining,,,) = renterPodFactory.requests(tokenIndex);
        assertEq(remaining, OPERATING_GAS - 0.0005 ether);
    }

    function testRenterUpdatesLiveKamibotsPrefsThroughFactory() public {
        (, uint32 tokenIndex) = _listAndPublish();
        _accept(tokenIndex);
        string memory aggressive = '{"node":1,"risk":"aggressive","regen":"REST"}';

        vm.prank(alice.owner);
        vm.expectRevert(RenterRoomPodFactory.NotRenter.selector);
        renterPodFactory.updateLeasePrefs(tokenIndex, aggressive);

        vm.prank(bob.owner);
        renterPodFactory.updateLeasePrefs(tokenIndex, aggressive);
        assertEq(renterPodFactory.prefs(tokenIndex), aggressive, "worker reads the renter's latest prefs");
    }

    function testRenterFundsExtensionAtomically() public {
        (, uint32 tokenIndex) = _listAndPublish();
        _accept(tokenIndex);
        uint64 beforeEnd = market.listings(tokenIndex).leaseEnd;
        (,, uint256 beforeBudget,,,) = renterPodFactory.requests(tokenIndex);
        uint256 addedBudget = 0.001 ether;

        vm.deal(bob.owner, addedBudget);
        vm.prank(bob.owner);
        renterPodFactory.extendLeaseAndTopUp{value: addedBudget}(tokenIndex, 1 days);

        assertEq(market.listings(tokenIndex).leaseEnd, beforeEnd + 1 days);
        (,, uint256 afterBudget,,,) = renterPodFactory.requests(tokenIndex);
        assertEq(afterBudget, beforeBudget + addedBudget, "extension gas stays in renter escrow");
    }

    function testUnusedOperatingGasRefundsAfterLeaseFinalization() public {
        (, uint32 tokenIndex) = _listAndPublish();
        _accept(tokenIndex);
        _fastForward(1 days + 1);
        market.endLease(tokenIndex);
        market.finalizeLease(tokenIndex);

        uint256 before = bob.owner.balance;
        renterPodFactory.finalizeGasRefund(tokenIndex);
        assertEq(bob.owner.balance, before + OPERATING_GAS);
        (address renter,,,,,) = renterPodFactory.requests(tokenIndex);
        assertEq(renter, address(0));
    }

    function testRenterFundedOperatorFinalizesAndRestoresPublishedPoolListing() public {
        (uint256 kamiID, uint32 tokenIndex) = _listAndPublish();
        _accept(tokenIndex);
        _fastForward(1 days + 1);
        vm.prank(lastPodOperator);
        market.endLease(tokenIndex);

        uint256 renterBefore = bob.owner.balance;
        vm.prank(lastPodOperator);
        renterPodFactory.finalizeMarketLease(tokenIndex);
        assertEq(bob.owner.balance, renterBefore + OPERATING_GAS, "unused operating gas returned");

        vm.prank(lastPodOperator);
        _KamiSendSystem.executeTyped(tokenIndex, address(pool));
        market.confirmReturnedToPool(tokenIndex);

        KamiLeaseMarket.Listing memory listing = market.listings(tokenIndex);
        assertEq(LibKami.getAccount(components, kamiID), pool.accID());
        assertFalse(listing.staked, "idle custody restored to owner pool");
        assertEq(listing.owner, address(pool), "listing remains published for the next renter");
        assertEq(market.listingBeneficiary(tokenIndex), alice.owner);
    }

    function testRenterCanCancelBeforeCustodyMovesAndRecoverOperatingGas() public {
        (uint256 kamiID, uint32 tokenIndex) = _listAndPublish();
        _request(tokenIndex);

        uint256 before = bob.owner.balance;
        vm.prank(bob.owner);
        renterPodFactory.cancelBeforeDispatch(tokenIndex);

        assertEq(bob.owner.balance, before + OPERATING_GAS);
        assertEq(market.pendingRenter(tokenIndex), address(0));
        assertEq(LibKami.getAccount(components, kamiID), pool.accID(), "idle Kami never left owner pool");
    }

    function testOwnerCannotCancelRentersPaidTerm() public {
        (, uint32 tokenIndex) = _listAndPublish();
        _accept(tokenIndex);

        vm.prank(alice.owner);
        vm.expectRevert(KamiLeaseMarket.NotRenter.selector);
        market.endLease(tokenIndex);

        _fastForward(1 days + 1);
        vm.prank(alice.owner); // expired: anyone may trigger the stop/finalize flow
        market.endLease(tokenIndex);
        market.finalizeLease(tokenIndex);
    }

    function testTenPercentFeeAndOwnerRenterSplitRemainInGlobalMarket() public {
        (uint256 kamiID, uint32 tokenIndex) = _listAndPublish();
        _accept(tokenIndex);
        _harvestInHub(kamiID, 100_000);

        uint256 gross = market.pendingXpDelta(tokenIndex);
        market.settle();
        uint256 platformCut = (gross * PLATFORM_BPS) / 10_000;
        uint256 net = gross - platformCut;
        assertEq(market.mgmtAccrued(), platformCut, "fixed 10% platform cut");
        assertEq(market.owedMusu(alice.owner), (net * OWNER_BPS) / 10_000);
        assertEq(
            market.owedMusu(bob.owner),
            net - ((net * OWNER_BPS) / 10_000),
            "renter receives post-fee remainder"
        );
    }

    function testSettlementRunsInBoundedPermissionlessContinuationBatches() public {
        _listAndPublish();
        _listAndPublish();

        market.settleBatch(1);
        assertTrue(market.settlementInProgress(), "first bounded batch leaves cycle open");
        assertEq(market.settleCursor(), 1);

        vm.prank(bob.owner);
        market.settleBatch(1);
        assertFalse(market.settlementInProgress(), "anyone can finish a started cycle");
        assertEq(market.settleCursor(), 0);

        vm.expectRevert(KamiLeaseMarket.Cooldown.selector);
        market.settleBatch(1);
    }

    function testSettlementRejectsUnboundedCallerInput() public {
        vm.expectRevert(KamiLeaseMarket.BadBatch.selector);
        market.settleBatch(0);
        vm.expectRevert(KamiLeaseMarket.BadBatch.selector);
        market.settleBatch(market.MAX_SETTLE_BATCH() + 1);
    }

    function testReturnGoesToPersonalPoolThenOwnerCanWithdraw() public {
        (uint256 kamiID, uint32 tokenIndex) = _listAndPublish();
        _accept(tokenIndex);
        _fastForward(1 days + 1);
        market.endLease(tokenIndex); // expired, permissionless
        market.finalizeLease(tokenIndex);

        vm.prank(alice.owner);
        pool.requestReturn(tokenIndex);
        assertTrue(market.listings(tokenIndex).returning, "pool routed the owner's return request");

        address returnTarget = address(pool);
        vm.prank(lastPodOperator);
        _KamiSendSystem.executeTyped(tokenIndex, returnTarget);
        market.clearReturned(tokenIndex);
        pool.syncReturned(tokenIndex);
        assertEq(LibKami.getAccount(components, kamiID), pool.accID());
        assertEq(market.listingBeneficiary(tokenIndex), address(0));

        _fastForward(2 hours);
        vm.prank(alice.owner);
        pool.withdrawToOwner(tokenIndex, alice.operator);
        assertEq(LibKami.getAccount(components, kamiID), alice.id, "only immutable owner receives it");
    }

    function testSealedMarketCannotRegainAdminButFeesRemainClaimableToFixedAccount() public {
        vm.expectRevert(KamiLeaseMarket.NotAdmin.selector);
        market.setMgmtAccount(bob.id);
        (uint256 kamiID, uint32 tokenIndex) = _listAndPublish();
        _accept(tokenIndex);
        _harvestInHub(kamiID, 100_000);
        RoomPod(lastPod).sweepMusu();
        market.settle();
        vm.prank(bob.owner);
        market.claimMgmt(); // anyone may relay; payout can only go to fixed charlie.id
    }
}
