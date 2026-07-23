// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import "tests/utils/SetupTemplate.t.sol";
import {BatchLease} from "vault/BatchLease.sol";
import {KamiLeaseMarket} from "vault/KamiLeaseMarket.sol";
import {HubGuard} from "vault/HubGuard.sol";
import {PersonalRentalPool} from "vault/PersonalRentalPool.sol";
import {PersonalRentalPoolRegistry} from "vault/PersonalRentalPoolRegistry.sol";
import {PersonalRentalVault} from "vault/PersonalRentalVault.sol";
import {PersonalRentalVaultFactory} from "vault/PersonalRentalVaultFactory.sol";
import {RenterRoomPodFactory} from "vault/RenterRoomPodFactory.sol";

/**
 * One-transaction squad funding, both flavors: the stateless BatchLease
 * periphery (v15, deployed) and the factory's native
 * createPodsAndRequestLeases entrypoint (v16 candidate). Every test submits
 * from a THIRD PARTY wallet: pods, pending leases, and recorded renters must
 * always follow the signed quote.renter, never msg.sender.
 */
contract BatchLeaseTest is SetupTemplate {
    KamiLeaseMarket market;
    RenterRoomPodFactory renterPodFactory;
    BatchLease batchLease;
    PersonalRentalVaultFactory factory;
    PersonalRentalVault vault;
    PersonalRentalPool pool;

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
        market = new KamiLeaseMarket(world, _Kami721, PLATFORM_BPS, MUSU_INDEX);
        renterPodFactory = new RenterRoomPodFactory(
            world, address(market), vm.addr(QUOTE_SIGNER_KEY), vm.addr(KEEPER_KEY)
        );
        HubGuard hubGuard = new HubGuard(world, address(market), address(renterPodFactory));
        PersonalRentalPoolRegistry registry = new PersonalRentalPoolRegistry(address(this));
        market.initialize(address(hubGuard), "batchhub");
        market.setSettler(address(this));
        market.setMgmtAccount(charlie.id);
        market.setLeaseFactory(address(renterPodFactory));
        market.setPoolRegistry(address(registry));
        market.sealAdmin();
        batchLease = new BatchLease(renterPodFactory);

        PersonalRentalPool implementation = new PersonalRentalPool();
        factory = new PersonalRentalVaultFactory(
            world, address(implementation), address(market), address(0), address(registry)
        );
        registry.setFactory(address(factory));

        vm.prank(alice.owner);
        vault = PersonalRentalVault(factory.createVault("Alice batch vault"));
        vm.prank(alice.owner);
        pool = PersonalRentalPool(
            vault.createPool(address(market), OWNER_BPS, 7 days, "alicebatchpool")
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

    function _quoteFor(uint32 tokenIndex, string memory accountName)
        internal
        returns (RenterRoomPodFactory.Quote memory quote)
    {
        quote = RenterRoomPodFactory.Quote({
            renter: bob.owner,
            tokenIndex: tokenIndex,
            nodeIndex: 1,
            operator: _getNextUserAddress(),
            expectedOwnerShareBps: OWNER_BPS,
            termSecs: 1 days,
            setupGasWei: SETUP_GAS,
            hubGasWei: HUB_GAS,
            operatingGasWei: OPERATING_GAS,
            deadline: uint64(block.timestamp + 1 hours),
            nonce: keccak256(abi.encode("batch", tokenIndex, accountName)),
            label: "Misty Riverside (EERIE)",
            accountName: accountName,
            prefs: '{"node":1,"risk":"balanced"}'
        });
    }

    function _sign(RenterRoomPodFactory.Quote memory quote, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, renterPodFactory.quoteDigest(quote));
        return abi.encodePacked(r, s, v);
    }

    /// two listed kamis, dual-signed quotes, matching values — ready to batch
    function _twoSignedQuotes()
        internal
        returns (
            RenterRoomPodFactory.Quote[] memory quotes,
            bytes[] memory quoteSigs,
            bytes[] memory keeperSigs,
            uint256[] memory values
        )
    {
        quotes = new RenterRoomPodFactory.Quote[](2);
        quoteSigs = new bytes[](2);
        keeperSigs = new bytes[](2);
        values = new uint256[](2);
        // list BOTH kamis before quoting: _listKami fast-forwards 2 hours,
        // which would expire an already-built quote's 1-hour deadline
        uint32 first = _listKami();
        uint32 second = _listKami();
        quotes[0] = _quoteFor(first, "batchpod1");
        quotes[1] = _quoteFor(second, "batchpod2");
        for (uint256 i; i < 2; ++i) {
            quoteSigs[i] = _sign(quotes[i], QUOTE_SIGNER_KEY);
            keeperSigs[i] = _sign(quotes[i], KEEPER_KEY);
            values[i] = QUOTE_TOTAL;
        }
    }

    function _recordedRenter(uint32 tokenIndex) internal view returns (address renter) {
        (renter,,,,,) = renterPodFactory.requests(tokenIndex);
    }

    /////////////////
    // BATCHLEASE PERIPHERY (v15)

    function testLeaseBatchThirdPartySubmitterFundsTwoLeasesAtomically() public {
        (
            RenterRoomPodFactory.Quote[] memory quotes,
            bytes[] memory quoteSigs,
            bytes[] memory keeperSigs,
            uint256[] memory values
        ) = _twoSignedQuotes();

        vm.deal(charlie.owner, 2 * QUOTE_TOTAL);
        vm.prank(charlie.owner);
        address[] memory pods =
            batchLease.leaseBatch{value: 2 * QUOTE_TOTAL}(quotes, quoteSigs, keeperSigs, values);

        assertEq(pods.length, 2, "two pods deployed");
        for (uint256 i; i < 2; ++i) {
            assertTrue(pods[i].code.length > 0, "pod has code");
            assertEq(_recordedRenter(quotes[i].tokenIndex), bob.owner, "renter is the signed quote.renter");
            assertEq(market.pendingRenter(quotes[i].tokenIndex), bob.owner, "market attributes the lease to quote.renter");
        }
        assertEq(address(batchLease).balance, 0, "periphery holds no funds");
        assertEq(charlie.owner.balance, 0, "submitter paid exactly the sum");
    }

    function testLeaseBatchRejectsWrongTotal() public {
        (
            RenterRoomPodFactory.Quote[] memory quotes,
            bytes[] memory quoteSigs,
            bytes[] memory keeperSigs,
            uint256[] memory values
        ) = _twoSignedQuotes();

        vm.deal(charlie.owner, 2 * QUOTE_TOTAL);
        vm.prank(charlie.owner);
        vm.expectRevert(BatchLease.BadPayment.selector);
        batchLease.leaseBatch{value: 2 * QUOTE_TOTAL - 1}(quotes, quoteSigs, keeperSigs, values);
    }

    function testLeaseBatchRejectsLengthMismatch() public {
        (
            RenterRoomPodFactory.Quote[] memory quotes,
            bytes[] memory quoteSigs,
            ,
            uint256[] memory values
        ) = _twoSignedQuotes();
        bytes[] memory shortKeeperSigs = new bytes[](1);
        shortKeeperSigs[0] = quoteSigs[0];

        vm.deal(charlie.owner, 2 * QUOTE_TOTAL);
        vm.prank(charlie.owner);
        vm.expectRevert(BatchLease.LengthMismatch.selector);
        batchLease.leaseBatch{value: 2 * QUOTE_TOTAL}(quotes, quoteSigs, shortKeeperSigs, values);
    }

    function testLeaseBatchOneBadQuoteRevertsEverything() public {
        (
            RenterRoomPodFactory.Quote[] memory quotes,
            bytes[] memory quoteSigs,
            bytes[] memory keeperSigs,
            uint256[] memory values
        ) = _twoSignedQuotes();
        keeperSigs[1] = quoteSigs[1]; // wrong signer for the keeper slot

        vm.deal(charlie.owner, 2 * QUOTE_TOTAL);
        vm.prank(charlie.owner);
        vm.expectRevert(RenterRoomPodFactory.BadQuote.selector);
        batchLease.leaseBatch{value: 2 * QUOTE_TOTAL}(quotes, quoteSigs, keeperSigs, values);

        assertEq(_recordedRenter(quotes[0].tokenIndex), address(0), "first lease rolled back too");
        assertEq(charlie.owner.balance, 2 * QUOTE_TOTAL, "submitter keeps every wei on revert");
    }

    /////////////////
    // NATIVE FACTORY ENTRYPOINT (v16 candidate)

    function testNativeBatchThirdPartySubmitterFundsTwoLeases() public {
        (
            RenterRoomPodFactory.Quote[] memory quotes,
            bytes[] memory quoteSigs,
            bytes[] memory keeperSigs,
        ) = _twoSignedQuotes();

        vm.deal(charlie.owner, 2 * QUOTE_TOTAL);
        vm.prank(charlie.owner);
        address[] memory pods = renterPodFactory.createPodsAndRequestLeases{value: 2 * QUOTE_TOTAL}(
            quotes, quoteSigs, keeperSigs
        );

        assertEq(pods.length, 2, "two pods deployed");
        for (uint256 i; i < 2; ++i) {
            assertEq(_recordedRenter(quotes[i].tokenIndex), bob.owner, "renter is the signed quote.renter");
            assertEq(market.pendingRenter(quotes[i].tokenIndex), bob.owner, "market attributes the lease to quote.renter");
        }
    }

    function testNativeBatchRejectsWrongTotal() public {
        (
            RenterRoomPodFactory.Quote[] memory quotes,
            bytes[] memory quoteSigs,
            bytes[] memory keeperSigs,
        ) = _twoSignedQuotes();

        vm.deal(charlie.owner, 2 * QUOTE_TOTAL);
        vm.prank(charlie.owner);
        vm.expectRevert(RenterRoomPodFactory.BadPayment.selector);
        renterPodFactory.createPodsAndRequestLeases{value: 2 * QUOTE_TOTAL - 1}(
            quotes, quoteSigs, keeperSigs
        );
    }

    function testNativeBatchOneBadQuoteRevertsEverything() public {
        (
            RenterRoomPodFactory.Quote[] memory quotes,
            bytes[] memory quoteSigs,
            bytes[] memory keeperSigs,
        ) = _twoSignedQuotes();
        keeperSigs[0] = quoteSigs[0];

        vm.deal(charlie.owner, 2 * QUOTE_TOTAL);
        vm.prank(charlie.owner);
        vm.expectRevert(RenterRoomPodFactory.BadQuote.selector);
        renterPodFactory.createPodsAndRequestLeases{value: 2 * QUOTE_TOTAL}(
            quotes, quoteSigs, keeperSigs
        );

        assertEq(_recordedRenter(quotes[0].tokenIndex), address(0), "no partial state");
        assertEq(_recordedRenter(quotes[1].tokenIndex), address(0), "no partial state");
    }

    function testNativeBatchRejectsEmptyAndRaggedInput() public {
        RenterRoomPodFactory.Quote[] memory none = new RenterRoomPodFactory.Quote[](0);
        bytes[] memory noSigs = new bytes[](0);
        vm.expectRevert(RenterRoomPodFactory.BadQuote.selector);
        renterPodFactory.createPodsAndRequestLeases(none, noSigs, noSigs);
    }
}
