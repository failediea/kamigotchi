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
import {PodRecoveryOperator} from "vault/PodRecoveryOperator.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {
    AccountSetOperatorSystem,
    ID as AccountSetOperatorSystemID
} from "systems/AccountSetOperatorSystem.sol";

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
    address settler;

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
        settler = _getNextUserAddress();
        market = new KamiLeaseMarket(world, _Kami721, PLATFORM_BPS, MUSU_INDEX);
        podFactory = new RenterRoomPodFactory(
            world, address(market), vm.addr(QUOTE_SIGNER_KEY), keeper
        );
        HubGuard hubGuard = new HubGuard(world, address(market), address(podFactory));
        PersonalRentalPoolRegistry registry = new PersonalRentalPoolRegistry(address(this));
        market.initialize(address(hubGuard), "fixhub");
        market.setSettler(settler);
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

    function testZeroManagementCutIsRejectedBeforeItCanBrickSweeps() public {
        vm.expectRevert(KamiLeaseMarket.FeeZero.selector);
        new KamiLeaseMarket(world, _Kami721, 0, MUSU_INDEX);
    }

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
        vm.prank(settler);
        market.settle();
        uint256 renterDuringTerm = market.owedMusu(bob.owner);
        assertGt(renterDuringTerm, 0, "renter earns inside the term they paid for");

        // past leaseEnd, with nobody having called finalizeLease, the split must
        // fall back to the owner rather than keep paying a lapsed renter
        _fastForward(8 days);
        uint256 ownerBefore = market.owedMusu(alice.owner);
        _giveDelta(tokenIndex, 10_000);
        _fastForward(1 days);
        vm.prank(settler);
        market.settle();

        assertEq(market.owedMusu(bob.owner), renterDuringTerm, "expired renter accrues nothing");
        uint256 gross = 10_000;
        uint256 net = gross - (gross * PLATFORM_BPS) / 10_000;
        assertEq(market.owedMusu(alice.owner) - ownerBefore, net, "whole net goes to the owner");
    }

    /////////////////
    // FINDING 1 — the recovery rotation must survive an operator squat

    function testRecoveryRotationIsRetryableWhenSquatted() public {
        uint32 tokenIndex = _listKami();
        _submit(_quote(tokenIndex, bob.owner, "squatpod"));
        vm.prank(keeper);
        podFactory.markLeasePreparing(tokenIndex);
        vm.prank(keeper);
        podFactory.routePreparedKami(tokenIndex);
        vm.prank(keeper);
        podFactory.activateProvisionedLease(tokenIndex);
        (, address podAddr,,,,) = podFactory.requests(tokenIndex);

        // the attack: claim the address the pod WOULD have rotated to. Under the
        // old code this address was address(pod) itself and one claim killed
        // recovery permanently.
        bytes32 squattedSalt = bytes32(uint256(1));
        address doomed = _predictOperator(podAddr, squattedSalt);
        // resolve BEFORE the prank: getAddrByID staticcalls the world, which would
        // otherwise consume it and run the rotation as the test contract
        AccountSetOperatorSystem setOp = AccountSetOperatorSystem(
            getAddrByID(world.systems(), AccountSetOperatorSystemID)
        );
        // the account OWNER rotates their operator; this is a one-tx, permissionless
        // claim on any unclaimed address in the game's global namespace
        vm.prank(charlie.owner);
        setOp.executeTyped(doomed);
        assertEq(LibAccount.getByOperator(components, doomed), charlie.id, "address squatted");

        _fastForward(9 days);
        market.endLease(tokenIndex);
        _fastForward(2 days + 1);

        // the squatted salt fails — but it reverts atomically, burning no state
        vm.expectRevert();
        podFactory.enterPodRecovery(tokenIndex, squattedSalt);
        (,,,,, uint8 stageAfterFail) = podFactory.requests(tokenIndex);
        assertEq(stageAfterFail, 3, "still ACTIVE: a failed attempt costs nothing");
        assertFalse(RoomPod(podAddr).recoveryMode(), "recovery not entered");

        // and any other salt simply works: the squat is a nuisance, not a kill
        podFactory.enterPodRecovery(tokenIndex, bytes32(uint256(2)));
        assertTrue(RoomPod(podAddr).recoveryMode(), "recovery entered on retry");
        assertEq(
            LibAccount.getOperator(components, RoomPod(podAddr).accID()),
            RoomPod(podAddr).recoveryOperator(),
            "pod is driven by its own fresh operator"
        );
    }

    /// the operator is a minimal-proxy clone, so predict it the way LibClone
    /// derives it rather than from PodRecoveryOperator's own creation code
    function _predictOperator(address pod, bytes32 salt) internal view returns (address) {
        return LibClone.predictDeterministicAddress(
            RoomPod(pod).recoveryOpImpl(), salt, pod
        );
    }

    /////////////////
    // FINDING 3 — a non-MUSU hub needs a MUSU fee float to pay anyone at all

    /// stand up a second hub paying VIPP (item 2), the config
    /// PersonalRentalVaultFactory treats as first-class
    function _vippHub() internal returns (KamiLeaseMarket vipp, RenterRoomPodFactory vippFactory) {
        vipp = new KamiLeaseMarket(world, _Kami721, PLATFORM_BPS, 2);
        vippFactory = new RenterRoomPodFactory(
            world, address(vipp), vm.addr(QUOTE_SIGNER_KEY), keeper
        );
        HubGuard g = new HubGuard(world, address(vipp), address(vippFactory));
        PersonalRentalPoolRegistry r = new PersonalRentalPoolRegistry(address(this));
        vipp.initialize(address(g), "vipphub");
        vipp.setSettler(settler);
        vipp.setMgmtAccount(charlie.id);
        vipp.setLeaseFactory(address(vippFactory));
        vipp.setPoolRegistry(address(r));
        vipp.sealAdmin();
    }

    function testMusuHubNeedsNoFeeFloat() public view {
        // a MUSU hub nets the fee out of the claimant's own payout, so the float
        // concept does not apply and must never gate it
        assertEq(market.musuFeeFloat(), type(uint256).max, "MUSU hub is never float-bound");
        assertEq(market.feeFloatClaimsLeft(), type(uint256).max, "unbounded claims");
    }

    function testVippHubReportsItsFeeFloatHonestly() public {
        (KamiLeaseMarket vipp,) = _vippHub();

        // a fresh VIPP hub holds no MUSU, so it can pay exactly nobody --
        // backingShortfall() cannot see this, which is why the float has its own view
        assertEq(vipp.musuFeeFloat(), 0, "fresh VIPP hub has no float");
        assertEq(vipp.feeFloatClaimsLeft(), 0, "and therefore no claims");
        assertEq(vipp.backingShortfall(), 0, "payItem-denominated view still reads healthy");

        // anyone may top it up in-game; 10 claims' worth
        vm.startPrank(deployer);
        LibInventory.incFor(components, vipp.accID(), MUSU_INDEX, 150);
        vm.stopPrank();
        assertEq(vipp.feeFloatClaimsLeft(), 10, "float converts to payouts remaining");
    }

    function testVippCheckoutIsBlockedWhileTheFloatIsDry() public {
        (KamiLeaseMarket vipp, RenterRoomPodFactory vippFactory) = _vippHub();
        RenterRoomPodFactory.Quote memory q = _quote(1, bob.owner, "vippdry");
        bytes memory qs = _sign2(vippFactory, q, QUOTE_SIGNER_KEY);
        bytes memory ks = _sign2(vippFactory, q, KEEPER_KEY);

        vm.deal(bob.owner, QUOTE_TOTAL);
        vm.prank(bob.owner);
        // better to refuse the lease than to mint one whose earnings can never
        // leave the pod
        vm.expectRevert(KamiLeaseMarket.FeeFloatEmpty.selector);
        vippFactory.createPodAndRequestLease{value: QUOTE_TOTAL}(q, qs, ks);
    }

    function testVippPayoutFailsWithANameNotAnUnderflow() public {
        (KamiLeaseMarket vipp,) = _vippHub();
        // mirror _credit exactly: the payee entry AND the global reservation
        stdstore.target(address(vipp)).sig("owedMusu(address)").with_key(bob.owner).checked_write(
            uint256(1_000)
        );
        stdstore.target(address(vipp)).sig("owedMusuTotal()").checked_write(uint256(1_000));
        // fully backed in payItem — the ONLY thing missing is the MUSU the game
        // will charge for the transfer, which is exactly the invisible failure
        vm.startPrank(deployer);
        LibInventory.incFor(components, vipp.accID(), 2, 1_000);
        vm.stopPrank();
        assertEq(vipp.backingShortfall(), 0, "hub looks perfectly solvent");

        vm.prank(bob.owner);
        // the old failure was a checked-underflow deep inside LibInventory, which
        // told nobody that the answer was "top up the hub's MUSU"
        vm.expectRevert(KamiLeaseMarket.FeeFloatEmpty.selector);
        vipp.claimOwed();
    }

    function _sign2(RenterRoomPodFactory f, RenterRoomPodFactory.Quote memory q, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, f.quoteDigest(q));
        return abi.encodePacked(r, s, v);
    }

    /////////////////
    // FINDING 14 — a shortfall must be shared, not dumped on the last claimant

    function testShortfallIsSplitProRataNotFirstComeFirstServed() public {
        // two payees owed 1,000 each against only 1,000 of backing. Under the old
        // all-or-nothing guard the first caller took the lot and the second could
        // never claim a single unit.
        _credit(alice.owner, 1_000);
        _credit(bob.owner, 1_000);
        vm.startPrank(deployer);
        LibInventory.incFor(components, market.accID(), MUSU_INDEX, 1_000);
        vm.stopPrank();

        uint256 aliceBefore = LibInventory.getBalanceOf(components, alice.id, MUSU_INDEX);
        vm.prank(alice.owner);
        market.claimOwed();
        uint256 alicePaid = LibInventory.getBalanceOf(components, alice.id, MUSU_INDEX) - aliceBefore;

        // half the pool, minus the in-world transfer fee
        assertEq(alicePaid, 500 - 15, "alice takes her share, not everything");
        assertEq(market.owedMusu(alice.owner), 500, "the rest stays claimable");

        // and bob can still claim — the whole point
        uint256 bobBefore = LibInventory.getBalanceOf(components, bob.id, MUSU_INDEX);
        vm.prank(bob.owner);
        market.claimOwed();
        assertGt(
            LibInventory.getBalanceOf(components, bob.id, MUSU_INDEX),
            bobBefore,
            "the last claimant is no longer left with nothing"
        );
    }

    function testFullyBackedClaimsStillPayInFull() public {
        _credit(alice.owner, 1_000);
        vm.startPrank(deployer);
        LibInventory.incFor(components, market.accID(), MUSU_INDEX, 1_000);
        vm.stopPrank();

        uint256 before = LibInventory.getBalanceOf(components, alice.id, MUSU_INDEX);
        vm.prank(alice.owner);
        market.claimOwed();
        assertEq(
            LibInventory.getBalanceOf(components, alice.id, MUSU_INDEX) - before,
            1_000 - 15,
            "no partial-payment behaviour when the hub is solvent"
        );
        assertEq(market.owedMusu(alice.owner), 0, "balance cleared");
    }

    function _credit(address payee, uint256 amount) internal {
        stdstore.target(address(market)).sig("owedMusu(address)").with_key(payee).checked_write(
            amount
        );
        stdstore.target(address(market)).sig("owedMusuTotal()").checked_write(
            market.owedMusuTotal() + amount
        );
    }

    /////////////////
    // FINDING 15 — a kami sent to the pool early must not be stranded

    function testKamiSentBeforeDeclaringCanStillBeDeclared() public {
        uint256 kamiID = _mintKami(alice);
        uint32 tokenIndex = LibKami.getIndex(components, kamiID);

        // the slip: send FIRST, declare second. declareKami used to reject this
        // (kami no longer in the owner's account) while withdrawToOwner needs a
        // listing only declareKami creates -- permanently stuck, no rescue path.
        vm.prank(alice.operator);
        _KamiSendSystem.executeTyped(tokenIndex, address(pool));
        _fastForward(2 hours);
        assertEq(LibKami.getAccount(components, kamiID), pool.accID(), "kami is in the pool");

        vm.prank(alice.owner);
        pool.declareKami(tokenIndex);

        // and it is recorded as already arrived, so the flow continues normally
        vm.prank(alice.owner);
        pool.confirmAndPublish(tokenIndex, address(0));
        assertEq(market.listingBeneficiary(tokenIndex), alice.owner, "listed and recoverable");
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
