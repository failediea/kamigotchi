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
      OWNER_BPS
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
    (, , , , , , , renter, ) = market.listings(tokenIndex);
  }

  /////////////////
  // LISTING -> POOL

  function testListingRules() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = LibKami.getIndex(components, kamiID);

    // not yours -> no
    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: kami not in your account");
    market.listKami(tokenIndex, OWNER_BPS, MIN_GAS);

    // farming -> not resting at full health -> no
    vm.prank(alice.operator);
    _HarvestStartSystem.executeTyped(kamiID, 1, 0, 0);
    vm.prank(alice.owner);
    vm.expectRevert("LeaseMkt: must be resting at full health");
    market.listKami(tokenIndex, OWNER_BPS, MIN_GAS);

    // stop + heal to full -> listable
    _fastForward(_idleRequirement);
    uint256 prodID = LibHarvest.getForKami(components, kamiID);
    vm.prank(alice.operator);
    _HarvestStopSystem.executeTyped(prodID);
    _healKami(kamiID, type(int32).max / 2);
    vm.prank(alice.owner);
    market.listKami(tokenIndex, OWNER_BPS, MIN_GAS);
  }

  function testPoolCustody() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);

    // listed but not sent: NOT rentable
    vm.deal(bob.owner, 1 ether);
    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: not in pool yet");
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS);

    // premature confirm fails
    vm.expectRevert("LeaseMkt: not arrived");
    market.confirmArrival(tokenIndex);

    // send in -> pooled: custody is the market's, owner literally cannot use it
    _sendIn(alice, tokenIndex);
    assertEq(LibKami.getAccount(components, kamiID), market.accID(), "custody");
    (, , , , , bool staked, , , ) = market.listings(tokenIndex);
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
    vm.expectRevert("LeaseMkt: not owner");
    market.delist(tokenIndex);

    vm.prank(alice.owner);
    market.delist(tokenIndex);
    assertEq(market.numListings(), 0, "not delisted");

    // pooled kamis exit via requestReturn instead
    uint256 kami2 = _mintKami(alice);
    uint32 idx2 = _listPool(alice, kami2);
    vm.prank(alice.owner);
    vm.expectRevert("LeaseMkt: in pool - use requestReturn");
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
      OWNER_BPS
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
    uint32 tokenIndex = _listPool(alice, kamiID);

    vm.prank(alice.owner);
    market.updateTerms(tokenIndex, 5000, MIN_GAS);

    vm.deal(bob.owner, 1 ether);
    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: terms changed");
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS);

    vm.prank(bob.owner);
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", 5000);
  }

  function testEndLeaseRefundsGas() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);

    uint256 balBefore = bob.owner.balance;
    vm.prank(bob.owner);
    market.endLease(tokenIndex);
    assertEq(bob.owner.balance - balBefore, MIN_GAS, "refund");
    assertEq(_renterOf(tokenIndex), address(0), "cleared");
    assertEq(market.numListings(), 1, "listing survives; kami back in the pool");
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

    assertEq(_accountMusu(alice) - aBefore, ownerCut - TRANSFER_FEE, "owner share");
    assertEq(_accountMusu(bob) - bBefore, renterCut - TRANSFER_FEE, "renter share");
    assertEq(_accountMusu(charlie) - cBefore, mgmtCut - TRANSFER_FEE, "platform fee");
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

    assertEq(_accountMusu(bob) - bBefore, bobExpected, "bob's isolated pool");
    assertEq(_accountMusu(dana) - dBefore, dExpected, "dana's isolated pool");
  }

  function testEndLeaseCarriesRenterShare() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);

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

  /////////////////
  // OWNER EXIT (pooled, unrented)

  function testReturnFlow() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);
    _marketHarvest(kamiID, 60_000);

    vm.prank(bob.owner);
    market.endLease(tokenIndex);

    vm.prank(alice.owner);
    market.requestReturn(tokenIndex);

    // returning blocks new leases
    vm.deal(dana().owner, 1 ether);
    vm.prank(dana().owner);
    vm.expectRevert("LeaseMkt: being returned");
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS);

    _fastForward(_idleRequirement);
    vm.prank(marketOperator);
    _KamiSendSystem.executeTyped(tokenIndex, alice.operator);

    market.clearReturned(tokenIndex);
    assertEq(LibKami.getAccount(components, kamiID), alice.id, "kami home");
    assertEq(market.numListings(), 0, "listing cleared");

    uint256 aBefore = _accountMusu(alice);
    market.settle();
    assertTrue(_accountMusu(alice) > aBefore, "carried earnings paid");
  }

  function testWithdrawGuards() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _list(alice, kamiID);

    vm.prank(alice.owner);
    vm.expectRevert("LeaseMkt: not in pool - use delist");
    market.withdrawKami(tokenIndex);

    _sendIn(alice, tokenIndex);
    _accept(bob, tokenIndex);

    vm.prank(alice.owner);
    vm.expectRevert("LeaseMkt: end lease first");
    market.withdrawKami(tokenIndex);

    vm.prank(bob.owner);
    vm.expectRevert("LeaseMkt: not owner");
    market.withdrawKami(tokenIndex);
  }

  /////////////////
  // GOVERNANCE / GUARDS

  function testSettleIsPermissionless() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);
    _marketHarvest(kamiID, 50_000);

    // anyone can trigger settlement — payouts can never be withheld (KLM-03).
    // still cooldown-gated so it can't be spammed.
    uint256 bBefore = _accountMusu(bob);
    vm.prank(_getNextUserAddress());
    market.settle();
    assertGt(_accountMusu(bob) - bBefore, 0, "rando-triggered settle paid the renter");
  }

  function testSettleCooldown() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);
    _marketHarvest(kamiID, 50_000);

    market.settle();

    _marketHarvest(kamiID, 50_000);
    vm.expectRevert("LeaseMkt: cooldown");
    market.settle();

    _fastForward(6 hours + 1);
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
    market.acceptLease{ value: MIN_GAS }(tokenIndex, "", OWNER_BPS);
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
    assertEq(market.owedMusuTotal(), ghostShare, "reserved total tracks it");
    assertGe(market.musuBalance(), market.owedMusuTotal(), "reserve physically backed");

    // a second kami with a registered renter, its own harvest + settle: the held
    // reserve must neither inflate nor deflate the new payout, and must survive
    uint32 b = _listPool(alice, _mintKami(alice));
    _acceptAs(bob.owner, b);
    _marketHarvest(LibKami.getByIndex(components, b), 100_000);
    _fastForward(6 hours + 1);

    uint256 bobShare = _renterNet(market.pendingXpDelta(b)) - TRANSFER_FEE;
    uint256 bBefore = _accountMusu(bob);
    market.settle();
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
    (, , , , , , bool returning, , ) = market.listings(idx);
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
    vm.expectRevert("LeaseMkt: already sent home - use clearReturned");
    market.cancelReturn(idx);

    // the correct path clears the listing
    market.clearReturned(idx);
    assertEq(market.numListings(), 0, "listing cleared, no phantom");
  }

  /////////////////
  // AUDIT FIX 3: settleBounded — pool-size can never lock funds

  function testSettleBoundedIsBatchedAndExact() public {
    PlayerAccount memory d = _getPlayerAccount(3);
    uint32 a = _listPool(alice, _mintKami(alice));
    uint32 b = _listPool(alice, _mintKami(alice));
    _accept(bob, a);
    _acceptAs(d.owner, b);
    _marketHarvest(LibKami.getByIndex(components, a), 100_000);
    _marketHarvest(LibKami.getByIndex(components, b), 100_000);

    uint256 bobShare = _renterNet(market.pendingXpDelta(a)) - TRANSFER_FEE;
    uint256 dShare = _renterNet(market.pendingXpDelta(b)) - TRANSFER_FEE;
    uint256 bBefore = _accountMusu(bob);
    uint256 dBefore = _accountMusu(d);

    // one entry per call: exactly one lease is paid this batch
    market.settleBounded(1);
    assertTrue(
      (_accountMusu(bob) > bBefore) != (_accountMusu(d) > dBefore),
      "exactly one lease paid in a size-1 batch"
    );

    // the next batch (after cooldown) covers the other — both exact
    _fastForward(6 hours + 1);
    market.settleBounded(1);
    assertEq(_accountMusu(bob) - bBefore, bobShare, "bob exact across batches");
    assertEq(_accountMusu(d) - dBefore, dShare, "dana exact across batches");
  }

  /////////////////
  // AUDIT R2: terminal-return carries are settleable by ANYONE (KLM-03)

  function testTerminalCarrySettleableByAnyone() public {
    uint32 idx = _listPool(alice, _mintKami(alice));
    _accept(bob, idx);
    _marketHarvest(LibKami.getByIndex(components, idx), 100_000);

    vm.prank(bob.owner);
    market.endLease(idx); // carries the lease split; bob participations -> 0
    vm.prank(alice.owner);
    market.requestReturn(idx);
    _fastForward(_idleRequirement);
    vm.prank(marketOperator);
    _KamiSendSystem.executeTyped(idx, alice.operator);
    market.clearReturned(idx); // alice participations -> 0

    assertEq(market.numListings(), 0, "listing cleared");
    assertGt(market.numCarries(), 0, "carry with earnings survives");

    // a completely unrelated address (0 participations) can still settle: the
    // documented "payouts can never be withheld" now holds in the terminal state
    uint256 aBefore = _accountMusu(alice);
    uint256 bBefore = _accountMusu(bob);
    vm.prank(_getNextUserAddress());
    market.settle();
    assertGt(_accountMusu(alice) - aBefore, 0, "owner carry paid");
    assertGt(_accountMusu(bob) - bBefore, 0, "renter carry paid");
  }

  /////////////////
  // AUDIT R2: harvest after requestReturn is carried, not orphaned (KLM-04)

  function testFinalHarvestAfterReturnIsCarried() public {
    uint32 idx = _listPool(alice, _mintKami(alice));
    uint256 kamiID = LibKami.getByIndex(components, idx);
    _accept(bob, idx);
    _marketHarvest(kamiID, 100_000);
    vm.prank(bob.owner);
    market.endLease(idx);

    vm.prank(alice.owner);
    market.requestReturn(idx); // snapshots XP here
    _marketHarvest(kamiID, 50_000); // a harvest lands AFTER the snapshot
    assertGt(market.pendingXpDelta(idx), 0, "post-request delta exists");

    _fastForward(_idleRequirement);
    vm.prank(marketOperator);
    _KamiSendSystem.executeTyped(idx, alice.operator);

    uint256 carriesBefore = market.numCarries();
    market.clearReturned(idx);
    // the post-request delta is carried by clearReturned, not deleted with the listing
    assertGt(market.numCarries(), carriesBefore, "final harvest carried");

    uint256 aBefore = _accountMusu(alice);
    vm.prank(_getNextUserAddress());
    market.settle();
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
    market.listKami721(tokenIndex, OWNER_BPS, MIN_GAS);
    vm.stopPrank();

    (, , , , , bool staked, , , ) = market.listings(tokenIndex);
    assertTrue(staked, "pooled in the listing tx");
    assertEq(LibKami.getAccount(components, kamiID), market.accID(), "custody: hub");

    _fastForward(2 hours);
    _accept(bob, tokenIndex);
    assertEq(_renterOf(tokenIndex), bob.owner, "instantly rentable");

    // full circle: lease ends -> NFT withdraw -> relist is one tx forever after
    vm.prank(bob.owner);
    market.endLease(tokenIndex);
    vm.prank(alice.owner);
    market.withdrawKami(tokenIndex);
    assertEq(_Kami721.ownerOf(uint256(tokenIndex)), alice.owner, "NFT returned");

    vm.startPrank(alice.owner);
    _Kami721.approve(address(market), uint256(tokenIndex));
    market.listKami721(tokenIndex, OWNER_BPS, MIN_GAS);
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
    market.listKami721(tokenIndex, OWNER_BPS, MIN_GAS);

    // no approval -> refuses
    vm.prank(alice.owner);
    vm.expectRevert();
    market.listKami721(tokenIndex, OWNER_BPS, MIN_GAS);
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
