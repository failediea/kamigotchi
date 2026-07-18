// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import "tests/utils/SetupTemplate.t.sol";
import { TRANSFER_FEE } from "libraries/LibInventory.sol";
import { KamiLeaseMarket } from "vault/KamiLeaseMarket.sol";
import { RoomPod } from "vault/RoomPod.sol";
import { HarvestGuard } from "vault/HarvestGuard.sol";

/**
 * HarvestGuard tests — SELF-FARM LEASE MODE.
 *
 * The guard contract is the pod's account OPERATOR and exposes exactly three
 * renter actions: start / collect / stop, gated live to hub.listings.renter.
 * Renters farm with their own wallet + gas. They mechanically cannot send,
 * sacrifice, sell, or act on kamis that aren't theirs. Shipping is keeper-only
 * and can only target the hub pool or the kami's recorded owner.
 */
contract HarvestGuardTest is SetupTemplate {
  KamiLeaseMarket market;
  RoomPod pod;
  HarvestGuard guard;
  address marketOperator;
  address keeper;

  uint16 constant MGMT_BPS = 1000;
  uint16 constant OWNER_BPS = 3000;
  uint128 constant MIN_GAS = 0.01 ether;
  uint32 constant POD_NODE = 1;

  function setUp() public override {
    super.setUp();

    marketOperator = _getNextUserAddress();
    keeper = _getNextUserAddress();

    market = new KamiLeaseMarket(world, _Kami721, MGMT_BPS);
    market.initialize(marketOperator, "leasemkt");
    market.setMgmtAccount(charlie.id);

    guard = new HarvestGuard(world, address(market), keeper);
    pod = new RoomPod(world, address(market), POD_NODE, "Misty Riverside (self-farm)");
    pod.initialize(address(guard), "selfpod1"); // THE GUARD IS THE OPERATOR
    guard.setPod(address(pod));

    vm.startPrank(deployer);
    _TimeComponent.authorizeWriter(address(_HarvestStartSystem));
    _TimeComponent.authorizeWriter(address(_HarvestCollectSystem));
    _TimeComponent.authorizeWriter(address(_HarvestStopSystem));
    vm.stopPrank();
  }

  /////////////////
  // HELPERS

  function _listPool(PlayerAccount memory acc, uint256 kamiID) internal returns (uint32 tokenIndex) {
    tokenIndex = LibKami.getIndex(components, kamiID);
    vm.prank(acc.owner);
    market.listKami(tokenIndex, OWNER_BPS, MIN_GAS);
    vm.prank(acc.operator);
    _KamiSendSystem.executeTyped(tokenIndex, marketOperator);
    market.confirmArrival(tokenIndex);
    _fastForward(2 hours);
  }

  function _acceptSelf(PlayerAccount memory renter, uint32 tokenIndex) internal {
    vm.deal(renter.owner, 1 ether);
    vm.prank(renter.owner);
    market.acceptLease{ value: MIN_GAS }(
      tokenIndex,
      '{"mode":"self","node":1}',
      OWNER_BPS
    );
  }

  /// @dev ops ships the kami into the SELF-FARM pod: target operator = the guard
  function _shipToSelfPod(uint32 tokenIndex) internal {
    vm.prank(marketOperator);
    _KamiSendSystem.executeTyped(tokenIndex, address(guard));
    _fastForward(2 hours);
  }

  function _accountMusu(PlayerAccount memory acc) internal view returns (uint256) {
    return LibInventory.getBalanceOf(components, acc.id, MUSU_INDEX);
  }

  /////////////////
  // RENTER SELF-FARMS WITH THEIR OWN WALLET

  function testRenterFarmsOwnLease() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _acceptSelf(bob, tokenIndex);
    _shipToSelfPod(tokenIndex);
    assertEq(LibKami.getAccount(components, kamiID), pod.accID(), "kami in self-pod");

    _fastForward(_idleRequirement);

    // bob signs his own farming — no automation anywhere
    vm.prank(bob.owner);
    uint256 harvestID = guard.start(tokenIndex);
    assertTrue(harvestID != 0, "harvest live");

    _incHarvestBounty(harvestID, 100_000);
    _fastForward(_idleRequirement);

    vm.prank(bob.owner);
    guard.collect(tokenIndex);
    assertTrue(pod.musuBalance() >= 100_000, "output landed in the pod");

    _fastForward(_idleRequirement);
    vm.prank(bob.owner);
    guard.stop(tokenIndex);

    // settle pays the exact per-lease pool, same math as bot mode
    uint256 gross = market.pendingXpDelta(tokenIndex);
    assertTrue(gross >= 100_000, "attribution");
    pod.sweepMusu();
    uint256 net = gross - (gross * MGMT_BPS) / 10000;
    uint256 ownerCut = (net * OWNER_BPS) / 10000;
    uint256 bBefore = _accountMusu(bob);
    market.settle();
    assertEq(_accountMusu(bob) - bBefore, (net - ownerCut) - TRANSFER_FEE, "renter cut");
  }

  function testOnlyTheRenterCanFarm() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _acceptSelf(bob, tokenIndex);
    _shipToSelfPod(tokenIndex);
    _fastForward(_idleRequirement);

    // not the renter -> nothing works (owner included: it's leased out)
    vm.prank(charlie.owner);
    vm.expectRevert("Guard: not your lease");
    guard.start(tokenIndex);
    vm.prank(alice.owner);
    vm.expectRevert("Guard: not your lease");
    guard.start(tokenIndex);

    // renter of kami A cannot touch kami B
    uint256 kami2 = _mintKami(alice);
    uint32 idx2 = _listPool(alice, kami2);
    PlayerAccount memory dana = _getPlayerAccount(3);
    vm.deal(dana.owner, 1 ether);
    vm.prank(dana.owner);
    market.acceptLease{ value: MIN_GAS }(idx2, '{"mode":"self","node":1}', OWNER_BPS);
    vm.prank(marketOperator);
    _KamiSendSystem.executeTyped(idx2, address(guard));
    _fastForward(2 hours);

    vm.prank(bob.owner);
    vm.expectRevert("Guard: not your lease");
    guard.start(idx2);
  }

  function testShippingIsKeeperOnlyAndDestinationConstrained() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _acceptSelf(bob, tokenIndex);
    _shipToSelfPod(tokenIndex);

    vm.prank(bob.owner);
    market.endLease(tokenIndex);
    _fastForward(2 hours);

    // renter cannot ship at all
    vm.prank(bob.owner);
    vm.expectRevert("Guard: not keeper");
    guard.ship(tokenIndex, marketOperator);

    // keeper cannot ship to an arbitrary destination
    PlayerAccount memory dana = _getPlayerAccount(3);
    vm.prank(keeper);
    vm.expectRevert("Guard: destination not hub or owner");
    guard.ship(tokenIndex, dana.operator);

    // hub is a valid destination
    vm.prank(keeper);
    guard.ship(tokenIndex, marketOperator);
    assertEq(LibKami.getAccount(components, kamiID), market.accID(), "back in the pool");

    // ... and so is the recorded owner (direct return)
    _fastForward(2 hours);
    vm.prank(marketOperator);
    _KamiSendSystem.executeTyped(tokenIndex, address(guard));
    _fastForward(2 hours);
    vm.prank(alice.owner);
    market.requestReturn(tokenIndex);
    vm.prank(keeper);
    guard.ship(tokenIndex, alice.operator);
    market.clearReturned(tokenIndex);
    assertEq(LibKami.getAccount(components, kamiID), alice.id, "kami home");
  }

  function testKeeperStopOnlyAfterLease() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _acceptSelf(bob, tokenIndex);
    _shipToSelfPod(tokenIndex);
    _fastForward(_idleRequirement);
    vm.prank(bob.owner);
    guard.start(tokenIndex);
    _fastForward(_idleRequirement);

    // lease is live: keeper may NOT interrupt the renter's harvest
    vm.prank(keeper);
    vm.expectRevert("Guard: lease active");
    guard.keeperStop(tokenIndex);

    // lease over + renter walked away mid-harvest: keeper cleans up
    vm.prank(bob.owner);
    market.endLease(tokenIndex);
    vm.prank(keeper);
    guard.keeperStop(tokenIndex);
    assertEq(guard.harvestOf(tokenIndex), 0, "harvest cleared");
  }
}
