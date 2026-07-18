// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import "tests/utils/SetupTemplate.t.sol";
import { TRANSFER_FEE } from "libraries/LibInventory.sol";
import { KamiLeaseMarket } from "vault/KamiLeaseMarket.sol";
import { RoomPod } from "vault/RoomPod.sol";
import { LeasePodRegistry } from "vault/LeasePodRegistry.sol";

/**
 * RoomPod + LeasePodRegistry tests — THE MULTI-ACCOUNT TILE MODEL.
 *
 * One parked account per tile. Idle kamis pool in the HUB; a leased kami is
 * KamiSent to the pod of the renter's chosen tile and farmed there. Accounts
 * never move rooms; tiles scale by adding pods.
 *
 * Under test:
 *  - pod lifecycle: contract-owned account, registry directory, per-node uniqueness
 *  - full lease cycle THROUGH a pod: hub pool -> pod -> farm -> sweep -> settle
 *    pays exact per-lease pools -> kami returns pod -> hub -> owner
 *  - money is one-way: sweep only reaches the hub; pod operator can't move funds
 */
contract RoomPodTest is SetupTemplate {
  KamiLeaseMarket market;
  LeasePodRegistry registry;
  RoomPod pod;
  address marketOperator;
  address podOperator;

  uint16 constant MGMT_BPS = 1000;
  uint16 constant OWNER_BPS = 3000;
  uint128 constant MIN_GAS = 0.01 ether;
  uint32 constant POD_NODE = 1;

  function setUp() public override {
    super.setUp();

    marketOperator = _getNextUserAddress();
    podOperator = _getNextUserAddress();

    market = new KamiLeaseMarket(world, _Kami721, MGMT_BPS);
    market.initialize(marketOperator, "leasemkt");
    market.setMgmtAccount(charlie.id);

    registry = new LeasePodRegistry(address(market));
    pod = new RoomPod(world, address(market), POD_NODE, "Misty Riverside (EERIE)");
    pod.initialize(podOperator, "leasepod1");
    registry.addPod(address(pod));

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

  function _accept(PlayerAccount memory renter, uint32 tokenIndex) internal {
    vm.deal(renter.owner, 1 ether);
    vm.prank(renter.owner);
    market.acceptLease{ value: MIN_GAS }(
      tokenIndex,
      '{"node":1,"risk":"balanced","regen":"REST"}',
      OWNER_BPS
    );
  }

  /// @dev ops routing: hub -> pod (renter's tile), both sends operator-gated
  function _shipToPod(uint32 tokenIndex) internal {
    vm.prank(marketOperator);
    _KamiSendSystem.executeTyped(tokenIndex, podOperator);
    _fastForward(2 hours); // post-send cooldown
  }

  function _podHarvest(uint256 kamiID, uint256 bounty) internal {
    _fastForward(_idleRequirement);
    vm.prank(podOperator);
    bytes memory raw = _HarvestStartSystem.executeTyped(kamiID, POD_NODE, 0, 0);
    uint256 prodID = abi.decode(raw, (uint256));
    _incHarvestBounty(prodID, bounty);
    _fastForward(_idleRequirement);
    vm.prank(podOperator);
    _HarvestStopSystem.executeTyped(prodID);
  }

  function _accountMusu(PlayerAccount memory acc) internal view returns (uint256) {
    return LibInventory.getBalanceOf(components, acc.id, MUSU_INDEX);
  }

  /////////////////
  // REGISTRY / LIFECYCLE

  function testPodDirectory() public {
    assertEq(registry.numPods(), 1);
    assertEq(registry.podForNode(POD_NODE), address(pod));
    assertEq(pod.nodeIndex(), POD_NODE);
    assertTrue(pod.accID() != 0, "pod account registered");

    // one pod per node
    RoomPod dup = new RoomPod(world, address(market), POD_NODE, "dup");
    dup.initialize(_getNextUserAddress(), "leasepodx");
    vm.expectRevert("Registry: node already served");
    registry.addPod(address(dup));

    // wrong hub rejected
    RoomPod stray = new RoomPod(world, address(0xdead), 2, "stray");
    vm.expectRevert("Registry: pod serves another hub");
    registry.addPod(address(stray));

    // uninitialized rejected
    RoomPod raw = new RoomPod(world, address(market), 2, "raw");
    vm.expectRevert("Registry: pod not initialized");
    registry.addPod(address(raw));

    (address[] memory addrs, uint32[] memory nodes, , string[] memory labels) = registry.allPods();
    assertEq(addrs[0], address(pod));
    assertEq(nodes[0], POD_NODE);
    assertEq(labels[0], "Misty Riverside (EERIE)");
  }

  function testRemovePod() public {
    registry.removePod(address(pod));
    assertEq(registry.numPods(), 0);
    assertEq(registry.podForNode(POD_NODE), address(0));

    address rando = _getNextUserAddress();
    vm.prank(rando);
    vm.expectRevert("Registry: not admin");
    registry.addPod(address(pod));
  }

  /////////////////
  // THE FULL POD LEASE CYCLE

  function testLeaseFarmedInPodSettlesExactly() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);

    // ops routes the kami to the renter's tile — custody moves hub -> pod
    _shipToPod(tokenIndex);
    assertEq(LibKami.getAccount(components, kamiID), pod.accID(), "kami parked in pod");

    // farmed at the pod's node; MUSU lands in the POD account, XP on the kami
    _podHarvest(kamiID, 100_000);
    assertTrue(pod.musuBalance() >= 100_000, "pod holds the earnings");

    // hub attribution still tracks the kami wherever it lives
    uint256 gross = market.pendingXpDelta(tokenIndex);
    assertTrue(gross >= 100_000, "xp attribution follows the kami");

    // sweep: pod -> hub (one-way, anyone can call)
    uint256 hubBefore = market.musuBalance();
    uint256 swept = pod.sweepMusu();
    assertEq(market.musuBalance() - hubBefore, swept, "sweep reached the hub");
    assertEq(pod.musuBalance(), 0, "pod emptied");

    // settle pays the exact per-lease pool
    uint256 mgmtCut = (gross * MGMT_BPS) / 10000;
    uint256 net = gross - mgmtCut;
    uint256 ownerCut = (net * OWNER_BPS) / 10000;
    uint256 aBefore = _accountMusu(alice);
    uint256 bBefore = _accountMusu(bob);
    market.settle();
    assertEq(_accountMusu(alice) - aBefore, ownerCut - TRANSFER_FEE, "owner share");
    assertEq(_accountMusu(bob) - bBefore, (net - ownerCut) - TRANSFER_FEE, "renter share");
  }

  function testKamiReturnsPodToHubToOwner() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);
    _shipToPod(tokenIndex);
    _podHarvest(kamiID, 50_000);

    vm.prank(bob.owner);
    market.endLease(tokenIndex);

    // ops return leg 1: pod -> hub (kami is resting after harvest stop)
    _fastForward(_idleRequirement);
    vm.prank(podOperator);
    _KamiSendSystem.executeTyped(tokenIndex, marketOperator);
    assertEq(LibKami.getAccount(components, kamiID), market.accID(), "back in the pool");

    // owner exits: request -> ops leg 2: hub -> owner -> clear
    vm.prank(alice.owner);
    market.requestReturn(tokenIndex);
    _fastForward(2 hours);
    vm.prank(marketOperator);
    _KamiSendSystem.executeTyped(tokenIndex, alice.operator);
    market.clearReturned(tokenIndex);
    assertEq(LibKami.getAccount(components, kamiID), alice.id, "kami home");
    assertEq(market.numListings(), 0, "listing cleared");
  }

  /////////////////
  // MONEY IS ONE-WAY

  function testPodOperatorCannotMoveFunds() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _listPool(alice, kamiID);
    _accept(bob, tokenIndex);
    _shipToPod(tokenIndex);
    _podHarvest(kamiID, 100_000);

    uint32[] memory indices = new uint32[](1);
    uint256[] memory amts = new uint256[](1);
    indices[0] = MUSU_INDEX;
    amts[0] = 1000;

    // ItemTransfer is OWNER-gated in-game; the operator has no path to the money
    vm.prank(podOperator);
    vm.expectRevert();
    _ItemTransferSystem.executeTyped(indices, amts, uint256(uint160(podOperator)));
  }

  function testSweepBelowFeeIsNoop() public {
    assertEq(pod.sweepMusu(), 0, "nothing to sweep");
  }
}
