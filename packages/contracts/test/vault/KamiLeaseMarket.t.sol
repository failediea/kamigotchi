// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import "tests/utils/SetupTemplate.t.sol";
import { TRANSFER_FEE } from "libraries/LibInventory.sol";
import { KamiLeaseMarket } from "vault/KamiLeaseMarket.sol";

/**
 * KamiLeaseMarket tests vs the real World fixture.
 *
 * Cast: alice = kami owner (lessor), bob = renter, charlie = platform mgmt account.
 * The market's operator is a fresh EOA (in prod: held by Kamibots only).
 */
contract KamiLeaseMarketTest is SetupTemplate {
  KamiLeaseMarket market;
  address marketOperator;

  uint16 constant MGMT_BPS = 1000; // 10% platform fee
  uint16 constant OWNER_BPS = 3000; // owner asks 30% of post-fee earnings
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

  function _listToMarket(PlayerAccount memory acc, uint256 kamiID) internal returns (uint32) {
    _unstakeKami(kamiID); // template: bridge 721 out to acc.owner
    uint32 tokenIndex = LibKami.getIndex(components, kamiID);

    vm.startPrank(acc.owner);
    _Kami721.approve(address(market), uint256(tokenIndex));
    market.listKami(tokenIndex, OWNER_BPS, MIN_GAS);
    vm.stopPrank();

    _stakeToMarket(tokenIndex);
    return tokenIndex;
  }

  function _stakeToMarket(uint32 tokenIndex) internal {
    uint256 id = market.accID();
    uint32 room = LibAccount.getRoom(components, id);
    _setMarketRoom(uint32(BRIDGE_721_ROOM));
    uint32[] memory idxs = new uint32[](1);
    idxs[0] = tokenIndex;
    market.stakeListings(idxs);
    _setMarketRoom(room == 0 ? 1 : room);
  }

  function _setMarketRoom(uint32 room) internal {
    uint256 id = market.accID(); // read BEFORE prank
    vm.prank(deployer);
    _IndexRoomComponent.set(id, room);
  }

  function _accept(PlayerAccount memory renter, uint32 tokenIndex) internal {
    vm.deal(renter.owner, 1 ether);
    vm.prank(renter.owner);
    market.acceptLease{ value: MIN_GAS }(tokenIndex, '{"node":1,"regen":"REST"}', OWNER_BPS);
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

  /////////////////
  // CUSTODY

  function testListStakesIntoMarketAccount() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listToMarket(alice, kamiID);

    assertEq(_Kami721.ownerOf(uint256(tokenIndex)), address(_Kami721), "721 custody");
    assertEq(LibKami.getAccount(components, kamiID), market.accID(), "in-world owner");
    (address owner, , , uint16 shareBps, , bool staked, , address renter, ) = market.listings(
      tokenIndex
    );
    assertEq(owner, alice.owner);
    assertEq(shareBps, OWNER_BPS);
    assertTrue(staked);
    assertEq(renter, address(0));
  }

  function testWithdrawOnlyOwnerOnlyWhenUnleased() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listToMarket(alice, kamiID);
    _accept(bob, tokenIndex);

    // leased: owner cannot pull the kami out from under the renter
    _setMarketRoom(uint32(BRIDGE_721_ROOM));
    vm.prank(alice.owner);
    vm.expectRevert("LeaseMkt: end lease first");
    market.withdrawKami(tokenIndex);

    // non-owner can never withdraw
    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: not owner");
    market.withdrawKami(tokenIndex);

    // owner ends lease, then withdraws; NFT goes to alice only
    vm.prank(alice.owner);
    market.endLease(tokenIndex);
    vm.prank(alice.owner);
    market.withdrawKami(tokenIndex);
    assertEq(_Kami721.ownerOf(uint256(tokenIndex)), alice.owner, "721 not returned");
  }

  /////////////////
  // LEASE LIFECYCLE

  function testAcceptLeaseGuards() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listToMarket(alice, kamiID);

    // below min gas
    vm.deal(bob.owner, 1 ether);
    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: gas budget too low");
    market.acceptLease{ value: MIN_GAS - 1 }(tokenIndex, "", OWNER_BPS);

    // owner cannot lease own kami
    vm.deal(alice.owner, 1 ether);
    vm.prank(alice.owner);
    vm.expectRevert("LeaseMkt: own kami");
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS);

    _accept(bob, tokenIndex);

    // double-lease blocked
    vm.deal(charlie.owner, 1 ether);
    vm.prank(charlie.owner);
    vm.expectRevert("LeaseMkt: already leased");
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS);
  }

  function testEndLeaseRefundsGas() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listToMarket(alice, kamiID);
    _accept(bob, tokenIndex);

    uint256 balBefore = bob.owner.balance;
    vm.prank(bob.owner);
    market.endLease(tokenIndex);
    assertEq(bob.owner.balance - balBefore, MIN_GAS, "gas not refunded");

    (, , , , , , , address renter, uint256 gasBudget) = market.listings(tokenIndex);
    assertEq(renter, address(0));
    assertEq(gasBudget, 0);
  }

  function testDripGasOnlyToOperator() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listToMarket(alice, kamiID);
    _accept(bob, tokenIndex);

    uint256 opBefore = marketOperator.balance;
    market.dripGas(tokenIndex, 0.004 ether); // admin == this test contract
    assertEq(marketOperator.balance - opBefore, 0.004 ether, "operator not funded");

    (, , , , , , , , uint256 gasBudget) = market.listings(tokenIndex);
    assertEq(gasBudget, MIN_GAS - 0.004 ether, "budget not decremented");

    vm.expectRevert("LeaseMkt: budget too low");
    market.dripGas(tokenIndex, 1 ether);

    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: not admin");
    market.dripGas(tokenIndex, 1);
  }

  /////////////////
  // SETTLEMENT

  function testSettleThreeWaySplit() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listToMarket(alice, kamiID);
    _accept(bob, tokenIndex);

    _marketHarvest(kamiID, 100_000);

    uint256 bal = market.musuBalance();
    // n=1 listing, m=0 carries -> feeBudget = (2*1+1)*fee
    uint256 feeBudget = 3 * TRANSFER_FEE;
    uint256 distributable = bal - feeBudget;
    uint256 mgmtCut = (distributable * MGMT_BPS) / 10000;
    uint256 pool = distributable - mgmtCut; // single kami: earns the whole pool
    uint256 ownerCut = (pool * OWNER_BPS) / 10000;
    uint256 renterCut = pool - ownerCut;

    uint256 aBefore = _accountMusu(alice);
    uint256 bBefore = _accountMusu(bob);
    uint256 cBefore = _accountMusu(charlie);

    market.settle();

    assertEq(_accountMusu(alice) - aBefore, ownerCut, "owner share");
    assertEq(_accountMusu(bob) - bBefore, renterCut, "renter share");
    assertEq(_accountMusu(charlie) - cBefore, mgmtCut, "platform fee");
  }

  function testUnleasedEarningsGoToOwner() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listToMarket(alice, kamiID);
    // no renter — platform farms it anyway
    _marketHarvest(kamiID, 50_000);
    assertTrue(market.pendingXpDelta(tokenIndex) > 0, "no attribution");

    uint256 bal = market.musuBalance();
    uint256 feeBudget = 3 * TRANSFER_FEE;
    uint256 distributable = bal - feeBudget;
    uint256 mgmtCut = (distributable * MGMT_BPS) / 10000;
    uint256 pool = distributable - mgmtCut;

    uint256 aBefore = _accountMusu(alice);
    market.settle();
    assertEq(_accountMusu(alice) - aBefore, pool, "owner should keep all post-fee");
  }

  function testPreLeaseEarningsStayWithOwner() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listToMarket(alice, kamiID);

    _marketHarvest(kamiID, 50_000); // earned BEFORE bob leases
    _accept(bob, tokenIndex); // acceptLease carries pending delta at owner-only terms
    _marketHarvest(kamiID, 50_000); // earned DURING the lease

    uint256 bal = market.musuBalance();
    // n=1 listing + m=1 carry -> feeBudget = (2*2+1)*fee
    uint256 feeBudget = 5 * TRANSFER_FEE;
    uint256 distributable = bal - feeBudget;
    uint256 mgmtCut = (distributable * MGMT_BPS) / 10000;
    uint256 pool = distributable - mgmtCut;

    // read attribution: live entry (leased) + carry (owner-only)
    uint256 liveDelta = market.pendingXpDelta(tokenIndex);
    (, , , uint256 carryDelta_) = market.carries(0);
    uint256 total = liveDelta + carryDelta_;

    uint256 liveEarn = (pool * liveDelta) / total;
    uint256 carryEarn = (pool * carryDelta_) / total;
    uint256 ownerExpected = carryEarn + (liveEarn * OWNER_BPS) / 10000;
    uint256 renterExpected = liveEarn - (liveEarn * OWNER_BPS) / 10000;

    uint256 aBefore = _accountMusu(alice);
    uint256 bBefore = _accountMusu(bob);
    market.settle();

    assertEq(_accountMusu(alice) - aBefore, ownerExpected, "owner split");
    assertEq(_accountMusu(bob) - bBefore, renterExpected, "renter split");
    assertEq(market.numCarries(), 0, "carries not cleared");
  }

  function testEndLeaseCarriesRenterShare() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listToMarket(alice, kamiID);
    _accept(bob, tokenIndex);

    _marketHarvest(kamiID, 100_000);

    vm.prank(bob.owner);
    market.endLease(tokenIndex); // carries the delta AT LEASE TERMS

    uint256 bal = market.musuBalance();
    uint256 feeBudget = (2 * 2 + 1) * TRANSFER_FEE; // 1 listing + 1 carry
    uint256 distributable = bal - feeBudget;
    uint256 mgmtCut = (distributable * MGMT_BPS) / 10000;
    uint256 pool = distributable - mgmtCut;
    uint256 ownerCut = (pool * OWNER_BPS) / 10000;

    uint256 bBefore = _accountMusu(bob);
    market.settle();
    assertEq(_accountMusu(bob) - bBefore, pool - ownerCut, "renter share after end");
  }

  /////////////////
  // IN-GAME KAMISEND DEPOSIT FLOW (the flow live players actually use)

  /// @dev full lifecycle: preRegister -> KamiSend in -> confirm -> lease -> settle -> withdraw
  function testSendInFlowEndToEnd() public {
    uint256 kamiID = _mintKami(alice); // minted kamis are already in-world in alice's account
    uint32 tokenIndex = LibKami.getIndex(components, kamiID);

    // STEP 1: declare before sending (verifies current in-game ownership)
    vm.prank(alice.owner);
    market.preRegisterSend(tokenIndex, OWNER_BPS, MIN_GAS);

    // confirm before arrival must fail
    vm.expectRevert("LeaseMkt: kami has not arrived");
    market.confirmSendIn(tokenIndex);

    // STEP 2: the in-game send (operator-signed, targets the market's operator)
    vm.prank(alice.operator);
    _KamiSendSystem.executeTyped(tokenIndex, marketOperator);
    assertEq(LibKami.getAccount(components, kamiID), market.accID(), "not arrived");
    assertTrue(market.kamiInMarket(tokenIndex), "view helper wrong");

    // STEP 3: confirm (anyone) -> listing exists at pre-registered terms
    market.confirmSendIn(tokenIndex);
    (address owner, , , uint16 shareBps, , bool staked, , , ) = market.listings(tokenIndex);
    assertEq(owner, alice.owner, "listing owner");
    assertEq(shareBps, OWNER_BPS, "listing terms");
    assertTrue(staked, "send-in should be live immediately");

    // lease + harvest + settle works identically to the 721 flow
    _fastForward(2 hours); // clear the post-send cooldown
    _accept(bob, tokenIndex);
    _marketHarvest(kamiID, 100_000);

    uint256 bal = market.musuBalance();
    uint256 feeBudget = 3 * TRANSFER_FEE;
    uint256 pool = ((bal - feeBudget) * (10000 - MGMT_BPS)) / 10000;
    uint256 bBefore = _accountMusu(bob);
    market.settle();
    assertEq(_accountMusu(bob) - bBefore, pool - (pool * OWNER_BPS) / 10000, "renter share");

    // withdraw: same trustless 721-bridge exit, only to alice
    vm.prank(bob.owner);
    market.endLease(tokenIndex);
    _setMarketRoom(uint32(BRIDGE_721_ROOM));
    vm.prank(alice.owner);
    market.withdrawKami(tokenIndex);
    assertEq(_Kami721.ownerOf(uint256(tokenIndex)), alice.owner, "721 not returned");
  }

  function testPreRegisterRequiresInGameOwnership() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = LibKami.getIndex(components, kamiID);

    // bob cannot pre-register alice's kami
    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: kami not in your account");
    market.preRegisterSend(tokenIndex, OWNER_BPS, MIN_GAS);
  }

  function testCannotClaimAfterArrivalWithoutPreRegistration() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = LibKami.getIndex(components, kamiID);

    // alice sends WITHOUT pre-registering (the documented mistake case)
    vm.prank(alice.operator);
    _KamiSendSystem.executeTyped(tokenIndex, marketOperator);

    // nobody can confirm (no pending) …
    vm.expectRevert("LeaseMkt: not pre-registered");
    market.confirmSendIn(tokenIndex);

    // … and nobody can pre-register it now (kami is in the market account, prior
    // ownership is unprovable) — recovery is a manual operator send-back
    vm.prank(alice.owner);
    vm.expectRevert("LeaseMkt: kami not in your account");
    market.preRegisterSend(tokenIndex, OWNER_BPS, MIN_GAS);
  }

  function testCancelPending() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = LibKami.getIndex(components, kamiID);

    vm.prank(alice.owner);
    market.preRegisterSend(tokenIndex, OWNER_BPS, MIN_GAS);

    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: not yours");
    market.cancelPending(tokenIndex);

    vm.prank(alice.owner);
    market.cancelPending(tokenIndex);
    (address pOwner, , ) = market.pendingSends(tokenIndex);
    assertEq(pOwner, address(0), "pending not cleared");
  }

  /////////////////
  // AUDIT FIXES (v3)

  function testSettleParticipantsOnly() public {
    uint256 kamiID = _mintKami(alice);
    _listToMarket(alice, kamiID);
    _marketHarvest(kamiID, 50_000);

    // a random address cannot settle (fee-burn spam guard)
    address rando = _getNextUserAddress();
    vm.prank(rando);
    vm.expectRevert("LeaseMkt: not a participant");
    market.settle();

    // but a participant (listing owner) always can — payouts can't be withheld
    vm.prank(alice.owner);
    market.settle();
  }

  function testSettleCooldown() public {
    uint256 kamiID = _mintKami(alice);
    _listToMarket(alice, kamiID);
    _marketHarvest(kamiID, 50_000);

    market.settle(); // admin

    _marketHarvest(kamiID, 50_000);
    vm.expectRevert("LeaseMkt: cooldown");
    market.settle();

    _fastForward(6 hours + 1);
    market.settle(); // ok after cooldown
  }

  function testAcceptRevertsIfTermsChanged() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listToMarket(alice, kamiID);

    // owner bumps their share after bob read the listing
    vm.prank(alice.owner);
    market.updateTerms(tokenIndex, 5000, MIN_GAS);

    // bob's accept (still expecting the old 30%) must revert, not silently bind
    vm.deal(bob.owner, 1 ether);
    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: terms changed");
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS);

    // accepting the actual current terms works
    vm.prank(bob.owner);
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", 5000);
  }

  /// @dev preferred exit: in-game send-back, no bridge room involved
  function testReturnFlowViaKamiSend() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = LibKami.getIndex(components, kamiID);

    // list via the send-in flow
    vm.prank(alice.owner);
    market.preRegisterSend(tokenIndex, OWNER_BPS, MIN_GAS);
    vm.prank(alice.operator);
    _KamiSendSystem.executeTyped(tokenIndex, marketOperator);
    market.confirmSendIn(tokenIndex);

    _fastForward(2 hours);
    _marketHarvest(kamiID, 60_000);

    // owner requests return: attribution frozen, new leases blocked
    vm.prank(alice.owner);
    market.requestReturn(tokenIndex);
    assertEq(market.numCarries(), 1, "delta not carried at request");

    vm.deal(bob.owner, 1 ether);
    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: being returned");
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS);

    // premature clear must fail
    vm.expectRevert("LeaseMkt: kami not home yet");
    market.clearReturned(tokenIndex);

    // ops bot sends it home (operator-signed, from anywhere — no bridge room)
    _fastForward(_idleRequirement);
    vm.prank(marketOperator);
    _KamiSendSystem.executeTyped(tokenIndex, alice.operator);

    market.clearReturned(tokenIndex);
    assertEq(LibKami.getAccount(components, kamiID), alice.id, "kami not home");
    assertEq(market.numListings(), 0, "listing not cleared");

    // carried earnings still pay out at the next settle
    uint256 aBefore = _accountMusu(alice);
    market.settle();
    assertTrue(_accountMusu(alice) > aBefore, "carried earnings lost");
  }

  function testEndLeaseCannotBeBlockedByRevertingRenter() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listToMarket(alice, kamiID);

    RevertingRenter evil = new RevertingRenter();
    vm.deal(address(evil), 1 ether);
    evil.doAccept{ value: MIN_GAS }(market, tokenIndex, OWNER_BPS);

    // owner can still terminate: refund falls back to pull-pattern instead of reverting
    vm.prank(alice.owner);
    market.endLease(tokenIndex);

    assertEq(market.owedEth(address(evil)), MIN_GAS, "refund not owed");
    (, , , , , , , address renter, ) = market.listings(tokenIndex);
    assertEq(renter, address(0), "lease not cleared");
  }

  /////////////////
  // BOUNDARIES

  function testOperatorCannotTransferMarketItems() public {
    uint256 kamiID = _mintKami(alice);
    _listToMarket(alice, kamiID);
    _marketHarvest(kamiID, 100_000);

    uint32[] memory indices = new uint32[](1);
    uint256[] memory amts = new uint256[](1);
    indices[0] = MUSU_INDEX;
    amts[0] = 1000;

    vm.prank(marketOperator);
    vm.expectRevert();
    _ItemTransferSystem.executeTyped(indices, amts, uint256(uint160(marketOperator)));
  }

  function testTermsLockedWhileLeased() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listToMarket(alice, kamiID);
    _accept(bob, tokenIndex);

    vm.prank(alice.owner);
    vm.expectRevert("LeaseMkt: leased");
    market.updateTerms(tokenIndex, 5000, MIN_GAS);
  }
}

/// @dev a renter contract that rejects ETH — used to prove lease termination
/// cannot be held hostage by a refund that reverts
contract RevertingRenter {
  function doAccept(KamiLeaseMarket m, uint32 idx, uint16 bps) external payable {
    m.acceptLease{ value: msg.value }(idx, "", bps);
  }

  receive() external payable {
    revert("no eth");
  }
}
