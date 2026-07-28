// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import {stdStorage, StdStorage} from "forge-std/Test.sol";

import "tests/utils/SetupTemplate.t.sol";
import {KamiLeaseMarket} from "vault/KamiLeaseMarket.sol";
import {HubGuard} from "vault/HubGuard.sol";
import {PersonalRentalPoolRegistry} from "vault/PersonalRentalPoolRegistry.sol";
import {RenterRoomPodFactory} from "vault/RenterRoomPodFactory.sol";

/**
 * The sub-fee dust trap and its release valve.
 *
 * In-game MUSU transfers cost a flat 15 MUSU, so `claimOwed` requires
 * `amount > 15`. A payee at or below that can NEVER claim — and because
 * `owedMusuTotal` reserves their balance until they do, the amount is
 * permanently subtracted from what management can ever withdraw. One abandoned
 * payee is dust; they accumulate, and nothing in v15 could ever clear them.
 *
 * `forfeitDust()` is the release valve: payee-only, and only while the balance
 * is genuinely unreachable, so it grants no admin power over user funds.
 *
 * REACHABILITY is argued from the code, not exercised here. Producing a real
 * credit needs a lease harvesting in a RoomPod, and every harvest test in this
 * repo currently reverts with OwnableWritable__NotWriter — HarvestStartSystem
 * is missing `Time` write access in deploy.json (test/systems/Harvest/*.t.sol
 * are red on a pristine tree, which is also why KamiLeaseMarket.t.sol is
 * skipped). The credit path itself is plain arithmetic:
 * `_creditSplit` gives the owner `(net * shareBps) / 10000`, so any small
 * `delta` lands under 15. These tests therefore write the balance directly and
 * verify the guard, the accounting and the authorisation around it.
 */
contract OwedDustTest is SetupTemplate {
    using stdStorage for StdStorage;

    KamiLeaseMarket market;
    address settler;

    uint256 constant QUOTE_SIGNER_KEY = 0xA11CE;
    uint256 constant KEEPER_KEY = 0xB0B;
    uint16 constant PLATFORM_BPS = 1_000;
    uint256 constant TRANSFER_FEE = 15; // LibInventory.TRANSFER_FEE

    function setUp() public override {
        super.setUp();
        settler = _getNextUserAddress();
        market = new KamiLeaseMarket(world, _Kami721, PLATFORM_BPS, MUSU_INDEX);
        RenterRoomPodFactory podFactory = new RenterRoomPodFactory(
            world, address(market), vm.addr(QUOTE_SIGNER_KEY), vm.addr(KEEPER_KEY)
        );
        HubGuard hubGuard = new HubGuard(world, address(market), address(podFactory));
        PersonalRentalPoolRegistry registry = new PersonalRentalPoolRegistry(address(this));
        market.initialize(address(hubGuard), "dusthub");
        market.setSettler(settler);
        market.setMgmtAccount(charlie.id);
        market.setLeaseFactory(address(podFactory));
        market.setPoolRegistry(address(registry));
        market.sealAdmin();
    }

    /// place a held balance exactly as `_credit` would: payee entry plus the
    /// matching reservation in the global total
    function _credit(address payee, uint256 amount) internal {
        stdstore.target(address(market)).sig("owedMusu(address)").with_key(payee).checked_write(
            amount
        );
        uint256 total = market.owedMusuTotal();
        stdstore.target(address(market)).sig("owedMusuTotal()").checked_write(total + amount);
    }

    /// the trap: earned, backed, and permanently unreachable
    function testSubFeeBalanceCannotBeClaimed() public {
        _credit(alice.owner, 9);
        vm.prank(alice.owner);
        vm.expectRevert(KamiLeaseMarket.NothingClaimable.selector);
        market.claimOwed();
        assertEq(market.owedMusu(alice.owner), 9, "balance still stranded");
    }

    /// exactly at the fee is still unreachable — the transfer would deliver zero
    function testBalanceEqualToFeeIsAlsoStranded() public {
        _credit(alice.owner, TRANSFER_FEE);
        vm.prank(alice.owner);
        vm.expectRevert(KamiLeaseMarket.NothingClaimable.selector);
        market.claimOwed();

        vm.prank(alice.owner);
        market.forfeitDust();
        assertEq(market.owedMusu(alice.owner), 0, "boundary case is forfeitable");
    }

    function testForfeitReleasesTheReservation() public {
        _credit(alice.owner, 9);
        uint256 reservedBefore = market.owedMusuTotal();

        vm.prank(alice.owner);
        market.forfeitDust();

        assertEq(market.owedMusu(alice.owner), 0, "balance cleared");
        assertEq(market.owedMusuTotal(), reservedBefore - 9, "reservation released");
    }

    function testForfeitMovesDustToManagement() public {
        _credit(alice.owner, 9);
        uint256 accruedBefore = market.mgmtAccrued();

        vm.prank(alice.owner);
        vm.expectEmit(true, false, false, true, address(market));
        emit KamiLeaseMarket.DustForfeited(alice.owner, 9);
        market.forfeitDust();

        // real backed inventory, so it goes to management rather than being burned
        assertEq(market.mgmtAccrued(), accruedBefore + 9, "dust becomes mgmt revenue");
    }

    /// the guard that stops this being a withdrawal path for real balances
    function testCannotForfeitAClaimableBalance() public {
        _credit(alice.owner, TRANSFER_FEE + 1);
        vm.prank(alice.owner);
        vm.expectRevert(KamiLeaseMarket.NotDust.selector);
        market.forfeitDust();
        assertEq(market.owedMusu(alice.owner), TRANSFER_FEE + 1, "claimable balance untouched");
    }

    function testCannotForfeitNothing() public {
        vm.prank(bob.owner);
        vm.expectRevert(KamiLeaseMarket.NotDust.selector);
        market.forfeitDust();
    }

    /// only the payee — nobody can clear someone else's balance, admin included
    function testForfeitOnlyAffectsTheCaller() public {
        _credit(alice.owner, 9);

        vm.prank(bob.owner);
        vm.expectRevert(KamiLeaseMarket.NotDust.selector);
        market.forfeitDust();

        vm.expectRevert(KamiLeaseMarket.NotDust.selector);
        market.forfeitDust(); // this test contract is the settler / former admin

        assertEq(market.owedMusu(alice.owner), 9, "alice's dust is hers alone");
    }

    /// a balance that later grows past the fee stops being dust
    function testGrownBalanceIsNoLongerForfeitable() public {
        _credit(alice.owner, 9);
        _credit(alice.owner, 40); // _credit overwrites the payee entry
        assertEq(market.owedMusu(alice.owner), 40, "balance grew past the fee");

        vm.prank(alice.owner);
        vm.expectRevert(KamiLeaseMarket.NotDust.selector);
        market.forfeitDust();
    }

    /// forfeiting twice is not a way to drain the reservation
    function testCannotForfeitTwice() public {
        _credit(alice.owner, 9);
        vm.prank(alice.owner);
        market.forfeitDust();
        uint256 totalAfter = market.owedMusuTotal();

        vm.prank(alice.owner);
        vm.expectRevert(KamiLeaseMarket.NotDust.selector);
        market.forfeitDust();
        assertEq(market.owedMusuTotal(), totalAfter, "total unchanged by the failed retry");
    }
}
