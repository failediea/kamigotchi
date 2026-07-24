// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import {stdStorage, StdStorage} from "forge-std/Test.sol";

import "tests/utils/SetupTemplate.t.sol";
import {KamiLeaseMarket} from "vault/KamiLeaseMarket.sol";
import {HarvestGuard} from "vault/HarvestGuard.sol";
import {HubGuard} from "vault/HubGuard.sol";
import {PersonalRentalPool} from "vault/PersonalRentalPool.sol";
import {PersonalRentalPoolRegistry} from "vault/PersonalRentalPoolRegistry.sol";
import {PersonalRentalVault} from "vault/PersonalRentalVault.sol";
import {PersonalRentalVaultFactory} from "vault/PersonalRentalVaultFactory.sol";
import {RenterRoomPodFactory} from "vault/RenterRoomPodFactory.sol";
import {RoomPod} from "vault/RoomPod.sol";

/**
 * Regressions for the 2026-07-24 security review.
 *
 * Each test names the finding it pins. Where the full lease machine is needed
 * to reach a state, note that every harvest path in this repo currently reverts
 * with OwnableWritable__NotWriter (HarvestStartSystem is missing `Time` write
 * access in deploy.json — test/systems/Harvest/*.t.sol are red on a pristine
 * tree), so states downstream of an actual harvest are reached by writing the
 * listing fields directly rather than by farming.
 */
contract AuditFixesTest is SetupTemplate {
    using stdStorage for StdStorage;

    KamiLeaseMarket market;
    RenterRoomPodFactory podFactory;
    PersonalRentalVaultFactory factory;
    PersonalRentalVault vault;
    PersonalRentalPool pool;
    HarvestGuard harvestGuard;
    address keeper;

    uint256 constant QUOTE_SIGNER_KEY = 0xA11CE;
    uint256 constant KEEPER_KEY = 0xB0B;
    uint128 constant SETUP_GAS = 0.001 ether;
    uint128 constant HUB_GAS = 0.0005 ether;
    uint128 constant OPERATING_GAS = 0.002 ether;
    uint256 constant QUOTE_TOTAL = uint256(SETUP_GAS) + uint256(HUB_GAS) + uint256(OPERATING_GAS);
    uint16 constant PLATFORM_BPS = 1_000;
    uint16 constant OWNER_BPS = 3_000;

    function setUp() public override {
        super.setUp();
        keeper = vm.addr(KEEPER_KEY);
        market = new KamiLeaseMarket(world, _Kami721, PLATFORM_BPS, MUSU_INDEX);
        podFactory = new RenterRoomPodFactory(
            world, address(market), vm.addr(QUOTE_SIGNER_KEY), keeper
        );
        HubGuard hubGuard = new HubGuard(world, address(market), address(podFactory));
        PersonalRentalPoolRegistry registry = new PersonalRentalPoolRegistry(address(this));
        market.initialize(address(hubGuard), "fixhub");
        market.setSettler(address(this));
        market.setMgmtAccount(charlie.id);
        market.setLeaseFactory(address(podFactory));
        market.setPoolRegistry(address(registry));
        market.sealAdmin();

        PersonalRentalPool implementation = new PersonalRentalPool();
        factory = new PersonalRentalVaultFactory(
            world, address(implementation), address(market), address(0), address(registry)
        );
        registry.setFactory(address(factory));
        vm.prank(alice.owner);
        vault = PersonalRentalVault(factory.createVault("Alice fix vault"));
        vm.prank(alice.owner);
        pool = PersonalRentalPool(
            vault.createPool(address(market), OWNER_BPS, 7 days, "alicefixpool")
        );
    }

    function _listKami() internal returns (uint32 tokenIndex) {
        uint256 kamiID = _mintKami(alice);
        tokenIndex = LibKami.getIndex(components, kamiID);
        vm.prank(alice.owner);
        pool.declareKami(tokenIndex);
        vm.prank(alice.operator);
        _KamiSendSystem.executeTyped(tokenIndex, address(pool));
        vm.prank(alice.owner);
        pool.confirmAndPublish(tokenIndex, address(0));
        _fastForward(2 hours);
    }

    function _quote(uint32 tokenIndex, address renter, string memory name)
        internal
        returns (RenterRoomPodFactory.Quote memory q)
    {
        q = RenterRoomPodFactory.Quote({
            renter: renter,
            tokenIndex: tokenIndex,
            nodeIndex: 1,
            operator: _getNextUserAddress(),
            expectedOwnerShareBps: OWNER_BPS,
            termSecs: 7 days,
            setupGasWei: SETUP_GAS,
            hubGasWei: HUB_GAS,
            operatingGasWei: OPERATING_GAS,
            deadline: uint64(block.timestamp + 1 hours),
            nonce: keccak256(abi.encode("fix", tokenIndex, name)),
            label: "Misty Riverside (EERIE)",
            accountName: name,
            prefs: '{"node":1}'
        });
    }

    function _sign(RenterRoomPodFactory.Quote memory q, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, podFactory.quoteDigest(q));
        return abi.encodePacked(r, s, v);
    }

    function _submit(RenterRoomPodFactory.Quote memory q) internal {
        vm.deal(q.renter, QUOTE_TOTAL);
        vm.prank(q.renter);
        podFactory.createPodAndRequestLease{value: QUOTE_TOTAL}(
            q, _sign(q, QUOTE_SIGNER_KEY), _sign(q, KEEPER_KEY)
        );
    }

    /////////////////
    // FINDING 8 — the self-rental guard was dead code

    function testOwnerCannotRentTheirOwnListing() public {
        uint32 tokenIndex = _listKami();
        // alice.owner is the pool's registered beneficiary; the OLD guard compared
        // the POOL CONTRACT to the renter EOA and could never be true
        assertEq(market.listingBeneficiary(tokenIndex), alice.owner, "beneficiary is the human");
        assertTrue(market.listingPool(tokenIndex) != alice.owner, "owner field is the pool, not her");

        RenterRoomPodFactory.Quote memory q = _quote(tokenIndex, alice.owner, "selfrent");
        // sign BEFORE expectRevert: _sign staticcalls quoteDigest, and an
        // external call in the argument list would consume the expectation
        bytes memory qs = _sign(q, QUOTE_SIGNER_KEY);
        bytes memory ks = _sign(q, KEEPER_KEY);
        vm.deal(alice.owner, QUOTE_TOTAL);
        vm.prank(alice.owner);
        vm.expectRevert(KamiLeaseMarket.OwnKami.selector);
        podFactory.createPodAndRequestLease{value: QUOTE_TOTAL}(q, qs, ks);
    }

    function testUnrelatedRenterIsStillAccepted() public {
        uint32 tokenIndex = _listKami();
        _submit(_quote(tokenIndex, bob.owner, "okrent"));
        assertEq(market.pendingRenter(tokenIndex), bob.owner, "third party may still rent");
    }

    /////////////////
    // FINDING 9 — stale grace clock + who may cancel a PREPARING lease

    function testGraceClockRestartsWhenPreparingBegins() public {
        uint32 tokenIndex = _listKami();
        _submit(_quote(tokenIndex, bob.owner, "clockpod"));

        // the old clock ran from pod creation, so burning the grace BEFORE
        // preparing left the lease killable the instant it was dispatched
        _fastForward(2 days + 1);
        vm.prank(keeper);
        podFactory.markLeasePreparing(tokenIndex);

        vm.prank(charlie.owner);
        vm.expectRevert(RenterRoomPodFactory.Grace.selector);
        podFactory.requestPreparingCancellation(tokenIndex);
    }

    function testRenterMayCancelPreparingImmediately() public {
        uint32 tokenIndex = _listKami();
        _submit(_quote(tokenIndex, bob.owner, "fastpod"));
        vm.prank(keeper);
        podFactory.markLeasePreparing(tokenIndex);

        vm.prank(bob.owner); // their money — no wait
        podFactory.requestPreparingCancellation(tokenIndex);
        (,,,,, uint8 stage) = podFactory.requests(tokenIndex);
        assertEq(stage, 4, "CANCEL_REQUESTED");
    }

    /// a silent renter must never trap the owner's kami
    function testAnyoneMayCancelPreparingAfterTheRealGrace() public {
        uint32 tokenIndex = _listKami();
        _submit(_quote(tokenIndex, bob.owner, "stallpod"));
        vm.prank(keeper);
        podFactory.markLeasePreparing(tokenIndex);

        _fastForward(2 days + 1);
        vm.prank(charlie.owner);
        podFactory.requestPreparingCancellation(tokenIndex);
        (,,,,, uint8 stage) = podFactory.requests(tokenIndex);
        assertEq(stage, 4, "stalled provisioning is always unwedgeable");
    }

    /////////////////
    // FINDING 6 — sweeps must pay for themselves

    function testMinSweepTracksTheManagementCut() public {
        uint32 tokenIndex = _listKami();
        _submit(_quote(tokenIndex, bob.owner, "sweeppod"));
        (, address podAddr,,,,) = podFactory.requests(tokenIndex);

        // at 1000 bps the flat 15 MUSU fee is covered only from 150 upward
        assertEq(RoomPod(podAddr).minSweep(), (15 * 10_000) / PLATFORM_BPS, "floor = fee / mgmtBps");
        assertEq(RoomPod(podAddr).minSweep(), 150, "150 at the deployed 10% cut");
        // and the pod records its deployer so the terminal sweep can bypass it
        assertEq(RoomPod(podAddr).factory(), address(podFactory), "factory recorded immutably");
    }

    function testDustSweepIsRefusedForOpenCallersButPodStaysSweepable() public {
        uint32 tokenIndex = _listKami();
        _submit(_quote(tokenIndex, bob.owner, "dustpod"));
        (, address podAddr,,,,) = podFactory.requests(tokenIndex);

        // 100 MUSU is above the raw 15 fee (the OLD floor) but below the
        // economic floor, so an open caller must be refused rather than allowed
        // to burn 15 against a 10 MUSU management cut
        vm.startPrank(deployer);
        LibInventory.incFor(components, RoomPod(podAddr).accID(), MUSU_INDEX, 100);
        vm.stopPrank();
        assertGt(uint256(100), uint256(15), "would have passed the old guard");
        vm.prank(charlie.owner);
        assertEq(RoomPod(podAddr).sweepMusu(), 0, "open caller refused below the floor");
    }

    /////////////////
    // FINDING 13 — an expired renter must stop earning

    function testExpiredRenterStopsAccruing() public {
        uint32 tokenIndex = _listKami();
        _submit(_quote(tokenIndex, bob.owner, "expirepod"));
        vm.prank(keeper);
        podFactory.markLeasePreparing(tokenIndex);
        vm.prank(keeper);
        podFactory.routePreparedKami(tokenIndex);
        vm.prank(keeper);
        podFactory.activateProvisionedLease(tokenIndex);

        KamiLeaseMarket.Listing memory live = market.listings(tokenIndex);
        assertEq(live.renter, bob.owner, "renter recorded");
        assertGt(live.leaseEnd, block.timestamp, "term is live");

        // credit a delta while the term is live -> renter gets their share
        _giveDelta(tokenIndex, 10_000);
        market.settle();
        uint256 renterDuringTerm = market.owedMusu(bob.owner);
        assertGt(renterDuringTerm, 0, "renter earns inside the term they paid for");

        // past leaseEnd, with nobody having called finalizeLease, the split must
        // fall back to the owner rather than keep paying a lapsed renter
        _fastForward(8 days);
        uint256 ownerBefore = market.owedMusu(alice.owner);
        _giveDelta(tokenIndex, 10_000);
        _fastForward(1 days);
        market.settle();

        assertEq(market.owedMusu(bob.owner), renterDuringTerm, "expired renter accrues nothing");
        uint256 gross = 10_000;
        uint256 net = gross - (gross * PLATFORM_BPS) / 10_000;
        assertEq(market.owedMusu(alice.owner) - ownerBefore, net, "whole net goes to the owner");
    }

    /// raise the kami's XP so the next settle sees a delta, without harvesting
    /// (every harvest path in this repo currently reverts — see the file header)
    function _giveDelta(uint32 tokenIndex, uint256 amount) internal {
        uint256 kamiID = market.listingKamiID(tokenIndex);
        vm.startPrank(deployer);
        LibExperience.inc(components, kamiID, amount);
        vm.stopPrank();
    }
}
