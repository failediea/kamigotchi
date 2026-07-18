// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import "tests/utils/SetupTemplate.t.sol";
import { TRANSFER_FEE } from "libraries/LibInventory.sol";
import { KamiLeaseMarket } from "vault/KamiLeaseMarket.sol";

/**
 * KamiLeaseMarket v5 tests — LIST IN PLACE, DELIVER ON RENT.
 *
 * The marketplace rules under test:
 *  - listing requires the kami to be RESTING at FULL HEALTH, in the owner's account
 *  - a listed kami stays home until someone rents it (no custody at listing)
 *  - acceptance re-checks commitment (still owned, still rested) + opens a 24h window
 *  - the lease ACTIVATES at delivery (earnings clock = arrival, not acceptance)
 *  - missed window -> renter refund + listing removed
 *  - per-lease exact pools: every lease is paid exactly its own kami's earnings
 *
 * Cast: alice = owner, bob = renter, charlie = platform mgmt account, dana = renter 2.
 */
contract KamiLeaseMarketTest is SetupTemplate {
  KamiLeaseMarket market;
  address marketOperator;

  uint16 constant MGMT_BPS = 1000; // 10%
  uint16 constant OWNER_BPS = 3000; // owner asks 30% post-fee
  uint128 constant MIN_GAS = 0.01 ether;

  function setUp() public override {
    super.setUp();

    marketOperator = _getNextUserAddress();
    market = new KamiLeaseMarket(world, _Kami721, MGMT_BPS);
    market.initialize(marketOperator, "leasemkt");
    market.setMgmtAccount(charlie.id);

    // pre-existing snapshot gap: harvest systems unauthorized on TimeComponent
    vm.startPrank(deployer);
    _TimeComponent.authorizeWriter(address(_HarvestStartSystem));
    _TimeComponent.authorizeWriter(address(_HarvestCollectSystem));
    _TimeComponent.authorizeWriter(address(_HarvestStopSystem));
    vm.stopPrank();
  }

  /////////////////
  // HELPERS

  function _list(PlayerAccount memory acc, uint256 kamiID) internal returns (uint32 tokenIndex) {
    tokenIndex = LibKami.getIndex(components, kamiID);
    vm.prank(acc.owner);
    market.listKami(tokenIndex, OWNER_BPS, MIN_GAS);
  }

  function _accept(PlayerAccount memory renter, uint32 tokenIndex) internal {
    vm.deal(renter.owner, 1 ether);
    vm.prank(renter.owner);
    market.acceptLease{ value: MIN_GAS }(tokenIndex, '{"risk":"balanced"}', OWNER_BPS);
  }

  /// @dev the owner's operator KamiSends the kami to the market; anyone confirms
  function _deliver(PlayerAccount memory acc, uint32 tokenIndex) internal {
    vm.prank(acc.operator);
    _KamiSendSystem.executeTyped(tokenIndex, marketOperator);
    market.confirmDelivery(tokenIndex);
  }

  function _listAcceptDeliver(
    PlayerAccount memory owner_,
    PlayerAccount memory renter,
    uint256 kamiID
  ) internal returns (uint32 tokenIndex) {
    tokenIndex = _list(owner_, kamiID);
    _accept(renter, tokenIndex);
    _deliver(owner_, tokenIndex);
    _fastForward(2 hours); // clear the post-send cooldown before farming
  }

  function _marketHarvest(uint256 kamiID, uint256 bounty) internal {
    _fastForward(_idleRequirement);
    vm.prank(marketOperator);
    bytes memory raw = _HarvestStartSystem.executeTyped(kamiID, 1, 0, 0);
    uint256 prodID = abi.decode(raw, (uint256));

    _incHarvestBounty(prodID, bounty);

    _fastForward(_idleRequirement);
    vm.prank(marketOperator);
    _HarvestStopSystem.executeTyped(prodID);
  }

  function _accountMusu(PlayerAccount memory acc) internal view returns (uint256) {
    return LibInventory.getBalanceOf(components, acc.id, MUSU_INDEX);
  }

  function _renterOf(uint32 tokenIndex) internal view returns (address renter) {
    (, , , , , , , renter, , ) = market.listings(tokenIndex);
  }

  /////////////////
  // LISTING RULES

  function testListKeepsKamiHome() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);

    // no custody moved: kami still in alice's account, still hers to look at
    assertEq(LibKami.getAccount(components, kamiID), alice.id, "kami should stay home");
    (address owner, , , uint16 shareBps, , bool staked, , , , ) = market.listings(tokenIndex);
    assertEq(owner, alice.owner);
    assertEq(shareBps, OWNER_BPS);
    assertFalse(staked, "not delivered yet");
    assertEq(market.numListings(), 1);
  }

  function testListRequiresOwnership() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = LibKami.getIndex(components, kamiID);
    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: kami not in your account");
    market.listKami(tokenIndex, OWNER_BPS, MIN_GAS);
  }

  function testListRequiresRestingFullHealth() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = LibKami.getIndex(components, kamiID);

    // harvesting kami cannot be listed
    vm.prank(alice.operator);
    _HarvestStartSystem.executeTyped(kamiID, 1, 0, 0);
    vm.prank(alice.owner);
    vm.expectRevert("LeaseMkt: must be resting at full health");
    market.listKami(tokenIndex, OWNER_BPS, MIN_GAS);

    // stop + heal back to full -> listable
    _fastForward(_idleRequirement);
    uint256 prodID = LibHarvest.getForKami(components, kamiID);
    vm.prank(alice.operator);
    _HarvestStopSystem.executeTyped(prodID);
    _healKami(kamiID, type(int32).max / 2); // clamp to max
    vm.prank(alice.owner);
    market.listKami(tokenIndex, OWNER_BPS, MIN_GAS);
  }

  function testDelist() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);

    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: not owner");
    market.delist(tokenIndex);

    vm.prank(alice.owner);
    market.delist(tokenIndex);
    assertEq(market.numListings(), 0, "not delisted");
  }

  /////////////////
  // RENT -> DELIVER LIFECYCLE

  function testAcceptOpensDeliveryWindow() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);
    _accept(bob, tokenIndex);

    (, , , , , bool staked, , address renter, , uint64 deliverBy) = market.listings(tokenIndex);
    assertFalse(staked, "not delivered yet");
    assertEq(renter, bob.owner);
    assertEq(uint256(deliverBy), block.timestamp + market.deliveryWindow(), "window");
  }

  function testAcceptBlockedWhileOwnerFarmsListedKami() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);

    // owner cheats: farms the listed kami -> it's simply unrentable
    vm.prank(alice.operator);
    _HarvestStartSystem.executeTyped(kamiID, 1, 0, 0);

    vm.deal(bob.owner, 1 ether);
    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: kami not rested - try later");
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS);
  }

  function testDeliveryActivatesLease() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);
    _accept(bob, tokenIndex);

    // premature confirm fails
    vm.expectRevert("LeaseMkt: not arrived");
    market.confirmDelivery(tokenIndex);

    _deliver(alice, tokenIndex);
    (, , , , , bool staked, , , , uint64 deliverBy) = market.listings(tokenIndex);
    assertTrue(staked, "lease should be active");
    assertEq(deliverBy, 0, "deadline cleared");
    assertEq(LibKami.getAccount(components, kamiID), market.accID(), "custody in market");
  }

  function testCancelUndeliveredRefundsAfterDeadline() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);
    _accept(bob, tokenIndex);

    // window still open
    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: window still open");
    market.cancelUndelivered(tokenIndex);

    _fastForward(uint256(market.deliveryWindow()) + 1);

    uint256 balBefore = bob.owner.balance;
    vm.prank(bob.owner);
    market.cancelUndelivered(tokenIndex);
    assertEq(bob.owner.balance - balBefore, MIN_GAS, "refund");
    assertEq(market.numListings(), 0, "flaky listing removed");
  }

  function testCancelUndeliveredBlockedIfArrived() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);
    _accept(bob, tokenIndex);

    // owner sends late, nobody confirmed yet, deadline passes
    vm.prank(alice.operator);
    _KamiSendSystem.executeTyped(tokenIndex, marketOperator);
    _fastForward(uint256(market.deliveryWindow()) + 1);

    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: it arrived - confirm it");
    market.cancelUndelivered(tokenIndex);
  }

  function testAcceptLeaseGuards() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);

    vm.deal(bob.owner, 1 ether);
    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: gas budget too low");
    market.acceptLease{ value: MIN_GAS - 1 }(tokenIndex, "", OWNER_BPS);

    vm.deal(alice.owner, 1 ether);
    vm.prank(alice.owner);
    vm.expectRevert("LeaseMkt: own kami");
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS);

    _accept(bob, tokenIndex);

    vm.deal(charlie.owner, 1 ether);
    vm.prank(charlie.owner);
    vm.expectRevert("LeaseMkt: already leased");
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS);
  }

  function testAcceptRevertsIfTermsChanged() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);

    vm.prank(alice.owner);
    market.updateTerms(tokenIndex, 5000, MIN_GAS);

    vm.deal(bob.owner, 1 ether);
    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: terms changed");
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS);

    vm.prank(bob.owner);
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", 5000);
  }

  function testEndLeaseBeforeDeliveryRefunds() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);
    _accept(bob, tokenIndex);

    uint256 balBefore = bob.owner.balance;
    vm.prank(bob.owner);
    market.endLease(tokenIndex);
    assertEq(bob.owner.balance - balBefore, MIN_GAS, "refund");
    assertEq(_renterOf(tokenIndex), address(0), "lease not cleared");
    assertEq(market.numListings(), 1, "listing survives an amicable end");
  }

  /////////////////
  // SETTLEMENT (per-lease exact pools — unchanged math, new delivery flow)

  function testSettleThreeWaySplit() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listAcceptDeliver(alice, bob, kamiID);

    _marketHarvest(kamiID, 100_000);

    uint256 gross = market.pendingXpDelta(tokenIndex);
    assertTrue(gross >= 100_000, "delta should cover injected bounty");
    uint256 mgmtCut = (gross * MGMT_BPS) / 10000;
    uint256 net = gross - mgmtCut;
    uint256 ownerCut = (net * OWNER_BPS) / 10000;
    uint256 renterCut = net - ownerCut;

    uint256 aBefore = _accountMusu(alice);
    uint256 bBefore = _accountMusu(bob);
    uint256 cBefore = _accountMusu(charlie);

    market.settle();

    assertEq(_accountMusu(alice) - aBefore, ownerCut - TRANSFER_FEE, "owner share");
    assertEq(_accountMusu(bob) - bBefore, renterCut - TRANSFER_FEE, "renter share");
    assertEq(_accountMusu(charlie) - cBefore, mgmtCut - TRANSFER_FEE, "platform fee");
  }

  function testPerLeasePoolsAreIsolated() public {
    PlayerAccount memory dana = _getPlayerAccount(3);
    uint256 aKami = _mintKami(alice);
    uint256 dKami = _mintKami(alice);
    uint32 aIdx = _listAcceptDeliver(alice, bob, aKami);
    uint32 dIdx = _listAcceptDeliver(alice, dana, dKami);

    _marketHarvest(aKami, 300_000);
    _marketHarvest(dKami, 100_000);

    uint256 aGross = market.pendingXpDelta(aIdx);
    uint256 dGross = market.pendingXpDelta(dIdx);
    uint256 aNet = aGross - (aGross * MGMT_BPS) / 10000;
    uint256 dNet = dGross - (dGross * MGMT_BPS) / 10000;
    uint256 bobExpected = (aNet - (aNet * OWNER_BPS) / 10000) - TRANSFER_FEE;
    uint256 dExpected = (dNet - (dNet * OWNER_BPS) / 10000) - TRANSFER_FEE;

    uint256 bBefore = _accountMusu(bob);
    uint256 dBefore = _accountMusu(dana);
    market.settle();

    assertEq(_accountMusu(bob) - bBefore, bobExpected, "bob's isolated pool");
    assertEq(_accountMusu(dana) - dBefore, dExpected, "dana's isolated pool");
  }

  function testEndLeaseCarriesRenterShare() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listAcceptDeliver(alice, bob, kamiID);

    _marketHarvest(kamiID, 100_000);

    vm.prank(bob.owner);
    market.endLease(tokenIndex);

    (, , , uint256 carryDelta_) = market.carries(0);
    uint256 net = carryDelta_ - (carryDelta_ * MGMT_BPS) / 10000;
    uint256 ownerCut = (net * OWNER_BPS) / 10000;

    uint256 bBefore = _accountMusu(bob);
    market.settle();
    assertEq(_accountMusu(bob) - bBefore, (net - ownerCut) - TRANSFER_FEE, "renter share");
  }

  function testEarningsClockStartsAtDelivery() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);
    _accept(bob, tokenIndex);

    // anything the kami "did" before delivery is invisible to the lease:
    // xpBase snapshots AT delivery, so pre-delivery XP can't leak into the pool
    _deliver(alice, tokenIndex);
    assertEq(market.pendingXpDelta(tokenIndex), 0, "clock must start at zero on arrival");
  }

  /////////////////
  // RETURN FLOW (delivered kamis)

  function testReturnFlowAfterLease() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listAcceptDeliver(alice, bob, kamiID);
    _marketHarvest(kamiID, 60_000);

    vm.prank(bob.owner);
    market.endLease(tokenIndex);

    vm.prank(alice.owner);
    market.requestReturn(tokenIndex);
    // endLease already carried the earned delta; requestReturn finds nothing new
    assertEq(market.numCarries(), 1, "delta carried once at end-lease");

    _fastForward(_idleRequirement);
    vm.prank(marketOperator);
    _KamiSendSystem.executeTyped(tokenIndex, alice.operator);

    market.clearReturned(tokenIndex);
    assertEq(LibKami.getAccount(components, kamiID), alice.id, "kami not home");
    assertEq(market.numListings(), 0, "listing not cleared");

    uint256 aBefore = _accountMusu(alice);
    market.settle();
    assertTrue(_accountMusu(alice) > aBefore, "carried earnings lost");
  }

  function testWithdrawGuards() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);

    // undelivered listing has no custody to withdraw
    vm.prank(alice.owner);
    vm.expectRevert("LeaseMkt: not delivered - use delist");
    market.withdrawKami(tokenIndex);

    _accept(bob, tokenIndex);
    _deliver(alice, tokenIndex);

    // leased: blocked
    vm.prank(alice.owner);
    vm.expectRevert("LeaseMkt: end lease first");
    market.withdrawKami(tokenIndex);

    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: not owner");
    market.withdrawKami(tokenIndex);
  }

  /////////////////
  // GOVERNANCE / SPAM GUARDS

  function testSettleParticipantsOnly() public {
    uint256 kamiID = _mintKami(alice);
    _listAcceptDeliver(alice, bob, kamiID);
    _marketHarvest(kamiID, 50_000);

    address rando = _getNextUserAddress();
    vm.prank(rando);
    vm.expectRevert("LeaseMkt: not a participant");
    market.settle();

    vm.prank(alice.owner);
    market.settle();
  }

  function testSettleCooldown() public {
    uint256 kamiID = _mintKami(alice);
    _listAcceptDeliver(alice, bob, kamiID);
    _marketHarvest(kamiID, 50_000);

    market.settle();

    _marketHarvest(kamiID, 50_000);
    vm.expectRevert("LeaseMkt: cooldown");
    market.settle();

    _fastForward(6 hours + 1);
    market.settle();
  }

  function testDeliveryWindowAdmin() public {
    vm.expectRevert("LeaseMkt: window out of range");
    market.setDeliveryWindow(30 minutes);
    market.setDeliveryWindow(48 hours);
    assertEq(market.deliveryWindow(), 48 hours);
    vm.prank(alice.owner);
    vm.expectRevert("LeaseMkt: not admin");
    market.setDeliveryWindow(24 hours);
  }

  function testEndLeaseCannotBeBlockedByRevertingRenter() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);

    RevertingRenter evil = new RevertingRenter();
    vm.deal(address(evil), 1 ether);
    evil.doAccept{ value: MIN_GAS }(market, tokenIndex, OWNER_BPS);

    vm.prank(alice.owner);
    market.endLease(tokenIndex);

    assertEq(market.owedEth(address(evil)), MIN_GAS, "refund not owed");
    assertEq(_renterOf(tokenIndex), address(0), "lease not cleared");
  }

  function testOperatorCannotTransferMarketItems() public {
    uint256 kamiID = _mintKami(alice);
    _listAcceptDeliver(alice, bob, kamiID);
    _marketHarvest(kamiID, 100_000);

    uint32[] memory indices = new uint32[](1);
    uint256[] memory amts = new uint256[](1);
    indices[0] = MUSU_INDEX;
    amts[0] = 1000;

    vm.prank(marketOperator);
    vm.expectRevert();
    _ItemTransferSystem.executeTyped(indices, amts, uint256(uint160(marketOperator)));
  }
}

/// @dev renter contract that rejects ETH — proves termination can't be held hostage
contract RevertingRenter {
  function doAccept(KamiLeaseMarket m, uint32 idx, uint16 bps) external payable {
    m.acceptLease{ value: msg.value }(idx, "", bps);
  }

  receive() external payable {
    revert("no eth");
  }
}
