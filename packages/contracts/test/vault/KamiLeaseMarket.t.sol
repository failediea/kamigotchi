// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import "tests/utils/SetupTemplate.t.sol";
import { TRANSFER_FEE } from "libraries/LibInventory.sol";
import { KamiLeaseMarket } from "vault/KamiLeaseMarket.sol";

/**
 * KamiLeaseMarket v6 tests — THE POOL MODEL.
 *
 * Rules under test:
 *  - listing requires RESTING at FULL HEALTH, then the kami is SENT INTO THE POOL:
 *    once pooled the owner cannot use it at all (custody-enforced, not policy)
 *  - pooled kamis sit unfarmed until rented; not rentable before arriving
 *  - renting is INSTANT; the renter takes control (their node + strategy via prefs)
 *  - per-lease exact pools: each lease is paid exactly its own kami's earnings
 *  - owner exits: delist (never sent) / requestReturn (pooled, unrented)
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
    market = new KamiLeaseMarket(world, _Kami721, MGMT_BPS, 1);
    market.initialize(marketOperator, "leasemkt");
    market.setSettler(address(this));
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
    market.listKami(tokenIndex, OWNER_BPS, MIN_GAS, 7 days, address(0));
  }

  /// @dev owner's operator sends the kami into the pool; anyone confirms
  function _sendIn(PlayerAccount memory acc, uint32 tokenIndex) internal {
    vm.prank(acc.operator);
    _KamiSendSystem.executeTyped(tokenIndex, marketOperator);
    market.confirmArrival(tokenIndex);
  }

  function _listPool(PlayerAccount memory acc, uint256 kamiID) internal returns (uint32 tokenIndex) {
    tokenIndex = _list(acc, kamiID);
    _sendIn(acc, tokenIndex);
    _fastForward(2 hours); // clear the post-send cooldown before farming
  }

  function _accept(PlayerAccount memory renter, uint32 tokenIndex) internal {
    vm.deal(renter.owner, 1 ether);
    vm.prank(renter.owner);
    market.acceptLease{ value: MIN_GAS }(
      tokenIndex,
      '{"node":1,"risk":"balanced","regen":"REST"}',
      OWNER_BPS,
      1 days
    );
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
    renter = market.listings(tokenIndex).renter;
  }

  function _endingOf(uint32 tokenIndex) internal view returns (bool ending) {
    ending = market.listings(tokenIndex).ending;
  }

  function _finishLease(uint32 tokenIndex) internal {
    market.finalizeLease(tokenIndex);
  }

  function _claim(PlayerAccount memory acc) internal {
    vm.prank(acc.owner);
    market.claimOwed();
  }

  /////////////////
  // LISTING -> POOL

  function testListingRules() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = LibKami.getIndex(components, kamiID);

    // not yours -> no
    vm.prank(bob.owner);
    vm.expectRevert(KamiLeaseMarket.KamiNotInYourAccount.selector);
    market.listKami(tokenIndex, OWNER_BPS, MIN_GAS, 7 days, address(0));

    // farming -> not resting at full health -> no
    vm.prank(alice.operator);
    _HarvestStartSystem.executeTyped(kamiID, 1, 0, 0);
    vm.prank(alice.owner);
    vm.expectRevert(KamiLeaseMarket.NotRestedFull.selector);
    market.listKami(tokenIndex, OWNER_BPS, MIN_GAS, 7 days, address(0));

    // stop + heal to full -> listable
    _fastForward(_idleRequirement);
    uint256 prodID = LibHarvest.getForKami(components, kamiID);
    vm.prank(alice.operator);
    _HarvestStopSystem.executeTyped(prodID);
    _healKami(kamiID, type(int32).max / 2);
    vm.prank(alice.owner);
    market.listKami(tokenIndex, OWNER_BPS, MIN_GAS, 7 days, address(0));
  }

  function testPoolCustody() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);

    // listed but not sent: NOT rentable
    vm.deal(bob.owner, 1 ether);
    vm.prank(bob.owner);
    vm.expectRevert(KamiLeaseMarket.NotInPoolYet.selector);
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS, 1 days);

    // premature confirm fails
    vm.expectRevert(KamiLeaseMarket.NotArrived.selector);
    market.confirmArrival(tokenIndex);

    // send in -> pooled: custody is the market's, owner literally cannot use it
    _sendIn(alice, tokenIndex);
    assertEq(LibKami.getAccount(components, kamiID), market.accID(), "custody");
    bool staked = market.listings(tokenIndex).staked;
    assertTrue(staked, "pooled");

    // owner's operator can no longer act on it (it's not in alice's account)
    _fastForward(2 hours);
    vm.prank(alice.operator);
    vm.expectRevert();
    _HarvestStartSystem.executeTyped(kamiID, 1, 0, 0);
  }

  function testDelistOnlyBeforeSend() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);

    vm.prank(bob.owner);
    vm.expectRevert(KamiLeaseMarket.NotOwner.selector);
    market.delist(tokenIndex);

    vm.prank(alice.owner);
    market.delist(tokenIndex);
    assertEq(market.numListings(), 0, "not delisted");

    // pooled kamis exit via requestReturn instead
    uint256 kami2 = _mintKami(alice);
    uint32 idx2 = _listPool(alice, kami2);
    vm.prank(alice.owner);
    vm.expectRevert(KamiLeaseMarket.InPoolUseReturn.selector);
    market.delist(idx2);
  }

  /////////////////
  // RENTING (instant, renter takes control)

  function testAcceptIsInstantAndCarriesPrefs() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);

    vm.deal(bob.owner, 1 ether);
    vm.prank(bob.owner);
    vm.expectEmit(true, true, false, true);
    emit KamiLeaseMarket.LeaseAccepted(
      bob.owner,
      tokenIndex,
      MIN_GAS,
      '{"node":3,"risk":"aggressive","regen":"FEED"}'
    );
    market.acceptLease{ value: MIN_GAS }(
      tokenIndex,
      '{"node":3,"risk":"aggressive","regen":"FEED"}', // THE RENTER's tile + strategy
      OWNER_BPS,
      1 days
    );

    assertEq(_renterOf(tokenIndex), bob.owner, "lease live immediately");
    // earnings clock clean at acceptance
    assertEq(market.pendingXpDelta(tokenIndex), 0, "clock starts at zero");
  }

  function testAcceptLeaseGuards() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);

    vm.deal(bob.owner, 1 ether);
    vm.prank(bob.owner);
    vm.expectRevert("LM: gas budget too low");
    market.acceptLease{ value: MIN_GAS - 1 }(tokenIndex, "", OWNER_BPS, 1 days);

    vm.deal(alice.owner, 1 ether);
    vm.prank(alice.owner);
    vm.expectRevert(KamiLeaseMarket.OwnKami.selector);
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS, 1 days);

    _accept(bob, tokenIndex);

    vm.deal(charlie.owner, 1 ether);
    vm.prank(charlie.owner);
    vm.expectRevert(KamiLeaseMarket.AlreadyLeased.selector);
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS, 1 days);
  }

  function testAcceptRevertsIfTermsChanged() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);

    vm.prank(alice.owner);
    market.updateTerms(tokenIndex, 5000, MIN_GAS, 7 days, address(0));

    vm.deal(bob.owner, 1 ether);
    vm.prank(bob.owner);
    vm.expectRevert(KamiLeaseMarket.TermsChanged.selector);
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS, 1 days);

    vm.prank(bob.owner);
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", 5000, 1 days);
  }

  function testEndLeaseRefundsGas() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);

    uint256 balBefore = bob.owner.balance;
    _fastForward(1 days + 1 hours); // renter is committed for MIN_TERM
    vm.prank(bob.owner);
    market.endLease(tokenIndex);
    assertEq(_renterOf(tokenIndex), bob.owner, "keeper has not finalized");
    _finishLease(tokenIndex);
    assertEq(bob.owner.balance - balBefore, MIN_GAS, "refund");
    assertEq(_renterOf(tokenIndex), address(0), "cleared");
    assertEq(market.numListings(), 1, "listing survives; kami back in the pool");
  }

  function testOwnerCanEndAndEndingBlocksChanges() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);

    vm.prank(alice.owner);
    market.endLease(tokenIndex);
    assertTrue(_endingOf(tokenIndex), "owner started ending");

    vm.prank(bob.owner);
    vm.expectRevert(KamiLeaseMarket.EndingNow.selector);
    market.setPrefs(tokenIndex, "{}");
    vm.prank(bob.owner);
    vm.expectRevert(KamiLeaseMarket.EndingNow.selector);
    market.topUpGas{ value: 1 }(tokenIndex);
  }

  function testRenterRecoversGasAndFinalizesAfterGrace() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);

    _fastForward(1 days + 1 hours); // renter is committed for MIN_TERM
    vm.prank(bob.owner);
    market.endLease(tokenIndex);
    vm.prank(bob.owner);
    vm.expectRevert("LM: grace");
    market.reclaimEndingGas(tokenIndex);

    _fastForward(2 days + 1);
    uint256 before = bob.owner.balance;
    vm.prank(bob.owner);
    market.reclaimEndingGas(tokenIndex);
    assertEq(bob.owner.balance - before, MIN_GAS, "timeout gas refund");

    vm.prank(bob.owner);
    market.finalizeLease(tokenIndex);
    assertEq(_renterOf(tokenIndex), address(0), "renter timeout finalized");
  }

  /////////////////
  // SETTLEMENT (per-lease exact pools)

  function testSettleThreeWaySplit() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);

    _marketHarvest(kamiID, 100_000);

    uint256 gross = market.pendingXpDelta(tokenIndex);
    assertTrue(gross >= 100_000, "delta covers bounty");
    uint256 mgmtCut = (gross * MGMT_BPS) / 10000;
    uint256 net = gross - mgmtCut;
    uint256 ownerCut = (net * OWNER_BPS) / 10000;
    uint256 renterCut = net - ownerCut;

    uint256 aBefore = _accountMusu(alice);
    uint256 bBefore = _accountMusu(bob);
    uint256 cBefore = _accountMusu(charlie);

    market.settle();
    assertEq(_accountMusu(alice), aBefore, "settle only records claims");
    assertEq(_accountMusu(bob), bBefore, "settle only records claims");
    assertEq(_accountMusu(charlie), cBefore, "mgmt is pull-based");
    assertEq(market.owedMusu(alice.owner), ownerCut, "owner credited");
    assertEq(market.owedMusu(bob.owner), renterCut, "renter credited");
    _claim(alice);
    _claim(bob);
    market.claimMgmt();
    assertEq(_accountMusu(alice) - aBefore, ownerCut - TRANSFER_FEE, "owner claim");
    assertEq(_accountMusu(bob) - bBefore, renterCut - TRANSFER_FEE, "renter claim");
    assertEq(_accountMusu(charlie) - cBefore, mgmtCut - TRANSFER_FEE, "platform claim");
  }

  function testPerLeasePoolsAreIsolated() public {
    PlayerAccount memory dana = _getPlayerAccount(3);
    uint256 aKami = _mintKami(alice);
    uint256 dKami = _mintKami(alice);
    uint32 aIdx = _listPool(alice, aKami);
    uint32 dIdx = _listPool(alice, dKami);
    _accept(bob, aIdx);
    _accept(dana, dIdx);

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
    _claim(bob);
    _claim(dana);
    assertEq(_accountMusu(bob) - bBefore, bobExpected, "bob's isolated pool");
    assertEq(_accountMusu(dana) - dBefore, dExpected, "dana's isolated pool");
  }

  function testEndLeaseCarriesRenterShare() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);

    _marketHarvest(kamiID, 100_000);

    _fastForward(1 days + 1 hours); // renter is committed for MIN_TERM
    vm.prank(bob.owner);
    market.endLease(tokenIndex);
    uint256 gross = market.pendingXpDelta(tokenIndex);
    _finishLease(tokenIndex);

    uint256 net = gross - (gross * MGMT_BPS) / 10000;
    uint256 ownerCut = (net * OWNER_BPS) / 10000;

    uint256 bBefore = _accountMusu(bob);
    _claim(bob);
    assertEq(_accountMusu(bob) - bBefore, (net - ownerCut) - TRANSFER_FEE, "renter share");
  }

  /////////////////
  // OWNER EXIT (pooled, unrented)

  function testReturnFlow() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);
    _marketHarvest(kamiID, 60_000);

    _fastForward(1 days + 1 hours); // renter is committed for MIN_TERM
    vm.prank(bob.owner);
    market.endLease(tokenIndex);
    _finishLease(tokenIndex);

    vm.prank(alice.owner);
    market.requestReturn(tokenIndex);

    // returning blocks new leases
    vm.deal(dana().owner, 1 ether);
    vm.prank(dana().owner);
    vm.expectRevert(KamiLeaseMarket.BeingReturned.selector);
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS, 1 days);

    _fastForward(_idleRequirement);
    vm.prank(marketOperator);
    _KamiSendSystem.executeTyped(tokenIndex, alice.operator);

    market.clearReturned(tokenIndex);
    assertEq(LibKami.getAccount(components, kamiID), alice.id, "kami home");
    assertEq(market.numListings(), 0, "listing cleared");

    uint256 aBefore = _accountMusu(alice);
    _claim(alice);
    assertTrue(_accountMusu(alice) > aBefore, "carried earnings paid");
  }

  function testWithdrawGuards() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);

    vm.prank(alice.owner);
    vm.expectRevert(KamiLeaseMarket.NotInPoolUseDelist.selector);
    market.withdrawKami(tokenIndex);

    _sendIn(alice, tokenIndex);
    _accept(bob, tokenIndex);

    vm.prank(alice.owner);
    vm.expectRevert(KamiLeaseMarket.EndLeaseFirst.selector);
    market.withdrawKami(tokenIndex);

    vm.prank(bob.owner);
    vm.expectRevert(KamiLeaseMarket.NotOwner.selector);
    market.withdrawKami(tokenIndex);
  }

  /////////////////
  // GOVERNANCE / GUARDS

  function testSettleIsKeeperScoped() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);
    _marketHarvest(kamiID, 50_000);

    vm.prank(_getNextUserAddress());
    vm.expectRevert(KamiLeaseMarket.NotSettler.selector);
    market.settle();
    market.settle();
    assertGt(market.owedMusu(bob.owner), 0, "keeper credited renter");
  }

  function testSettleBecomesPermissionlessWhenKeeperIsStale() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);
    _marketHarvest(kamiID, 50_000);
    address caller = _getNextUserAddress();

    vm.prank(caller);
    vm.expectRevert(KamiLeaseMarket.NotSettler.selector);
    market.settle();

    _fastForward(3 days + 1);
    vm.prank(caller);
    market.settle();
    assertGt(market.owedMusu(bob.owner), 0, "stale fallback credited renter");
  }

  function testSettleCooldown() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);
    _marketHarvest(kamiID, 50_000);

    market.settle();

    _marketHarvest(kamiID, 50_000);
    vm.expectRevert(KamiLeaseMarket.Cooldown.selector);
    market.settle();

    _fastForward(1 days + 1);
    market.settle();
  }

  function testEndLeaseCannotBeBlockedByRevertingRenter() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);

    RevertingRenter evil = new RevertingRenter();
    vm.deal(address(evil), 1 ether);
    evil.doAccept{ value: MIN_GAS }(market, tokenIndex, OWNER_BPS);

    vm.prank(alice.owner);
    market.endLease(tokenIndex);
    market.finalizeLease(tokenIndex);

    assertEq(market.owedEth(address(evil)), MIN_GAS, "refund not owed");
    assertEq(_renterOf(tokenIndex), address(0), "lease not cleared");
  }

  function testOperatorCannotTransferMarketItems() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);
    _marketHarvest(kamiID, 100_000);

    uint32[] memory indices = new uint32[](1);
    uint256[] memory amts = new uint256[](1);
    indices[0] = MUSU_INDEX;
    amts[0] = 1000;

    vm.prank(marketOperator);
    vm.expectRevert();
    _ItemTransferSystem.executeTyped(indices, amts, uint256(uint160(marketOperator)));
  }

  function dana() internal view returns (PlayerAccount memory) {
    return _getPlayerAccount(3);
  }

  /// @dev accept a lease from an ARBITRARY address (e.g. one with no game account)
  function _acceptAs(address renter, uint32 tokenIndex) internal {
    vm.deal(renter, 1 ether);
    vm.prank(renter);
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS, 1 days);
  }

  /// @dev the renter's pre-transfer-fee share of a kami's gross earnings
  function _renterNet(uint256 gross) internal pure returns (uint256) {
    uint256 net = gross - (gross * MGMT_BPS) / 10000;
    return net - (net * OWNER_BPS) / 10000;
  }

  /////////////////
  // AUDIT FIX 1: held payouts (owedMusu) are RESERVED, never re-promised

  function testOwedMusuReservedAcrossSettles() public {
    address ghost = _getNextUserAddress(); // no game account -> its share is held
    uint32 a = _listPool(alice, _mintKami(alice));
    _acceptAs(ghost, a);
    _marketHarvest(LibKami.getByIndex(components, a), 100_000);
    uint256 ghostShare = _renterNet(market.pendingXpDelta(a));

    market.settle();
    assertEq(market.owedMusu(ghost), ghostShare, "ghost share held");
    assertGe(market.owedMusuTotal(), ghostShare, "reserved total tracks all claims");
    assertGe(market.musuBalance(), market.owedMusuTotal(), "reserve physically backed");

    // a second kami with a registered renter, its own harvest + settle: the held
    // reserve must neither inflate nor deflate the new payout, and must survive
    uint32 b = _listPool(alice, _mintKami(alice));
    _acceptAs(bob.owner, b);
    _marketHarvest(LibKami.getByIndex(components, b), 100_000);
    _fastForward(1 days + 1);

    uint256 bobShare = _renterNet(market.pendingXpDelta(b)) - TRANSFER_FEE;
    uint256 bBefore = _accountMusu(bob);
    market.settle();
    _claim(bob);
    assertEq(_accountMusu(bob) - bBefore, bobShare, "bob paid exactly his own");
    assertEq(market.owedMusu(ghost), ghostShare, "ghost reserve untouched by later settle");
    assertGe(market.musuBalance(), market.owedMusuTotal(), "reserve still backed");
  }

  /////////////////
  // AUDIT FIX 2: cancelReturn cannot re-open a listing after the kami went home

  function testCancelReturnBlockedAfterSentHome() public {
    uint256 kamiID = _mintKami(alice);
    uint32 idx = _listPool(alice, kamiID);

    // while still pooled, cancelReturn re-opens normally
    vm.prank(alice.owner);
    market.requestReturn(idx);
    vm.prank(alice.owner);
    market.cancelReturn(idx);
    bool returning = market.listings(idx).returning;
    assertFalse(returning, "reopened while still in the pool");

    // request again, then the automation actually sends it home
    vm.prank(alice.owner);
    market.requestReturn(idx);
    _fastForward(_idleRequirement);
    vm.prank(marketOperator);
    _KamiSendSystem.executeTyped(idx, alice.operator);
    assertEq(LibKami.getAccount(components, kamiID), alice.id, "kami home");

    // now cancelReturn MUST revert — re-opening would be a phantom lease
    vm.prank(alice.owner);
    vm.expectRevert(KamiLeaseMarket.AlreadySentHome.selector);
    market.cancelReturn(idx);

    // the correct path clears the listing
    market.clearReturned(idx);
    assertEq(market.numListings(), 0, "listing cleared, no phantom");
  }

  /////////////////
  // AUDIT FIX 3: settleBounded — pool-size can never lock funds

  /////////////////
  // Terminal returns preserve already-credited claims without a public settle.

  function testTerminalCarrySettleableByAnyone() public {
    uint32 idx = _listPool(alice, _mintKami(alice));
    _accept(bob, idx);
    _marketHarvest(LibKami.getByIndex(components, idx), 100_000);

    _fastForward(1 days + 1 hours); // renter is committed for MIN_TERM
    vm.prank(bob.owner);
    market.endLease(idx);
    _finishLease(idx);
    vm.prank(alice.owner);
    market.requestReturn(idx);
    _fastForward(_idleRequirement);
    vm.prank(marketOperator);
    _KamiSendSystem.executeTyped(idx, alice.operator);
    market.clearReturned(idx); // alice participations -> 0

    assertEq(market.numListings(), 0, "listing cleared");
    assertGt(market.owedMusu(alice.owner), 0, "owner claim survives");
    assertGt(market.owedMusu(bob.owner), 0, "renter claim survives");
    uint256 aBefore = _accountMusu(alice);
    uint256 bBefore = _accountMusu(bob);
    _claim(alice);
    _claim(bob);
    assertGt(_accountMusu(alice) - aBefore, 0, "owner claim paid");
    assertGt(_accountMusu(bob) - bBefore, 0, "renter claim paid");
  }

  /////////////////
  // AUDIT R2: harvest after requestReturn is carried, not orphaned (KLM-04)

  function testFinalHarvestAfterReturnIsCarried() public {
    uint32 idx = _listPool(alice, _mintKami(alice));
    uint256 kamiID = LibKami.getByIndex(components, idx);
    _accept(bob, idx);
    _marketHarvest(kamiID, 100_000);
    _fastForward(1 days + 1 hours); // renter is committed for MIN_TERM
    vm.prank(bob.owner);
    market.endLease(idx);
    _finishLease(idx);

    vm.prank(alice.owner);
    market.requestReturn(idx); // snapshots XP here
    _marketHarvest(kamiID, 50_000); // a harvest lands AFTER the snapshot
    assertGt(market.pendingXpDelta(idx), 0, "post-request delta exists");

    _fastForward(_idleRequirement);
    vm.prank(marketOperator);
    _KamiSendSystem.executeTyped(idx, alice.operator);

    uint256 owedBefore = market.owedMusu(alice.owner);
    market.clearReturned(idx);
    assertGt(market.owedMusu(alice.owner), owedBefore, "final harvest credited");

    uint256 aBefore = _accountMusu(alice);
    _claim(alice);
    assertGt(_accountMusu(alice) - aBefore, 0, "final harvest paid to owner, not lost");
  }

  /////////////////
  // ONE-TX 721 LISTING (market account lives in the bridge room, like live)

  function _setMarketRoom(uint32 room) internal {
    vm.startPrank(deployer);
    _IndexRoomComponent.set(market.accID(), room);
    vm.stopPrank();
  }

  function testListKami721OneTxAndFullCycle() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = LibKami.getIndex(components, kamiID);
    _unstakeKami(kamiID); // NFT sits in alice's wallet
    _setMarketRoom(uint32(BRIDGE_721_ROOM));

    // approve + list = pooled + rentable IN THE SAME TX. no send, no operator.
    vm.startPrank(alice.owner);
    _Kami721.approve(address(market), uint256(tokenIndex));
    market.listKami721(tokenIndex, OWNER_BPS, MIN_GAS, 7 days, address(0));
    vm.stopPrank();

    bool staked = market.listings(tokenIndex).staked;
    assertTrue(staked, "pooled in the listing tx");
    assertEq(LibKami.getAccount(components, kamiID), market.accID(), "custody: hub");

    _fastForward(2 hours);
    _accept(bob, tokenIndex);
    assertEq(_renterOf(tokenIndex), bob.owner, "instantly rentable");

    // full circle: lease ends -> NFT withdraw -> relist is one tx forever after
    _fastForward(1 days + 1 hours); // renter is committed for MIN_TERM
    vm.prank(bob.owner);
    market.endLease(tokenIndex);
    _finishLease(tokenIndex);
    vm.prank(alice.owner);
    market.withdrawKami(tokenIndex);
    assertEq(_Kami721.ownerOf(uint256(tokenIndex)), alice.owner, "NFT returned");

    vm.startPrank(alice.owner);
    _Kami721.approve(address(market), uint256(tokenIndex));
    market.listKami721(tokenIndex, OWNER_BPS, MIN_GAS, 7 days, address(0));
    vm.stopPrank();
    assertEq(market.numListings(), 1, "relisted in one tx");
  }

  function testListKami721Guards() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = LibKami.getIndex(components, kamiID);
    _unstakeKami(kamiID);
    _setMarketRoom(uint32(BRIDGE_721_ROOM));

    // not yours -> the 721 transfer itself refuses
    vm.prank(bob.owner);
    vm.expectRevert();
    market.listKami721(tokenIndex, OWNER_BPS, MIN_GAS, 7 days, address(0));

    // no approval -> refuses
    vm.prank(alice.owner);
    vm.expectRevert();
    market.listKami721(tokenIndex, OWNER_BPS, MIN_GAS, 7 days, address(0));
  }
  /////////////////
  // TERM RAILS + PRIVATE LEASES

  function testTermRails() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = LibKami.getIndex(components, kamiID);

    vm.prank(alice.owner);
    vm.expectRevert(KamiLeaseMarket.TermRails.selector);
    market.listKami(tokenIndex, OWNER_BPS, MIN_GAS, uint32(12 hours), address(0));

    vm.prank(alice.owner);
    vm.expectRevert(KamiLeaseMarket.TermRails.selector);
    market.listKami(tokenIndex, OWNER_BPS, MIN_GAS, uint32(31 days), address(0));

    tokenIndex = _listPool(alice, kamiID); // lists with a 7 day cap

    vm.deal(bob.owner, 1 ether);
    vm.prank(bob.owner);
    vm.expectRevert(KamiLeaseMarket.TermRails.selector);
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS, 8 days);

    vm.prank(bob.owner);
    vm.expectRevert(KamiLeaseMarket.TermRails.selector);
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS, 12 hours);

    _accept(bob, tokenIndex); // 1 day term — inside the rails
    assertEq(
      market.listings(tokenIndex).leaseEnd,
      uint64(block.timestamp + 1 days),
      "leaseEnd stamped"
    );
  }

  function testRenterMinTermCommitmentOwnerExempt() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);

    vm.prank(bob.owner);
    vm.expectRevert(KamiLeaseMarket.MinTerm.selector);
    market.endLease(tokenIndex);

    // the owner may recall at any time
    vm.prank(alice.owner);
    market.endLease(tokenIndex);
    assertTrue(_endingOf(tokenIndex), "owner end is immediate");
  }

  function testPrivateLeaseReservedRenterOnly() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = LibKami.getIndex(components, kamiID);
    address vip = _getNextUserAddress();
    vm.prank(alice.owner);
    market.listKami(tokenIndex, OWNER_BPS, MIN_GAS, 7 days, vip);
    _sendIn(alice, tokenIndex);
    _fastForward(2 hours);

    vm.deal(bob.owner, 1 ether);
    vm.prank(bob.owner);
    vm.expectRevert(KamiLeaseMarket.Reserved.selector);
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS, 1 days);

    vm.deal(vip, 1 ether);
    vm.prank(vip);
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS, 1 days);
    assertEq(_renterOf(tokenIndex), vip, "reserved renter leases");
  }

  function testExtendLeaseWithinOwnerCap() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex); // 1 day term, 7 day cap

    vm.prank(bob.owner);
    market.extendLease(tokenIndex, 3 days);
    assertEq(
      market.listings(tokenIndex).leaseEnd,
      uint64(block.timestamp + 4 days),
      "extended in place"
    );

    vm.prank(bob.owner);
    vm.expectRevert(KamiLeaseMarket.TermRails.selector);
    market.extendLease(tokenIndex, 4 days); // 8 days total > 7 day cap

    vm.prank(_getNextUserAddress());
    vm.expectRevert(KamiLeaseMarket.NotRenter.selector);
    market.extendLease(tokenIndex, 1 days);
  }

  function testExpiredLeaseAnyoneCanEnd() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex); // 1 day term

    address stranger = _getNextUserAddress();
    vm.prank(stranger);
    vm.expectRevert(KamiLeaseMarket.NotParty.selector);
    market.endLease(tokenIndex); // not expired yet

    _fastForward(1 days + 1);
    vm.prank(stranger);
    market.endLease(tokenIndex); // expired: anyone (the keeper) may flip it
    assertTrue(_endingOf(tokenIndex), "expired lease flipped to ending");
    market.finalizeLease(tokenIndex); // the settler completes it
    assertEq(_renterOf(tokenIndex), address(0), "lease closed");
  }

  function testAdminHandOffTwoStep() public {
    address customer = _getNextUserAddress();

    // only the pending admin can accept — a stranger cannot hijack the hand-off
    market.transferAdmin(customer);
    vm.prank(_getNextUserAddress());
    vm.expectRevert(KamiLeaseMarket.NotPendingAdmin.selector);
    market.acceptAdmin();

    // until acceptance the platform is still admin (can cancel with address(0))
    assertEq(market.admin(), address(this));
    vm.prank(customer);
    market.acceptAdmin();
    assertEq(market.admin(), customer);
    assertEq(market.pendingAdmin(), address(0));

    // old admin has lost all power; the customer now holds the kill switch
    vm.expectRevert(KamiLeaseMarket.NotAdmin.selector);
    market.setSettler(address(this));
    vm.prank(customer);
    market.setSettler(customer);
  }

}

/// @dev renter contract that rejects ETH — proves termination can't be held hostage
contract RevertingRenter {
  function doAccept(KamiLeaseMarket m, uint32 idx, uint16 bps) external payable {
    m.acceptLease{ value: msg.value }(idx, "", bps, 1 days);
  }

  receive() external payable {
    revert("no eth");
  }
}
