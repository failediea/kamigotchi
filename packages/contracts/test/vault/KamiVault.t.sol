// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import "tests/utils/SetupTemplate.t.sol";
import { TRANSFER_FEE } from "libraries/LibInventory.sol";
import { KamiVault } from "vault/KamiVault.sol";

/**
 * KamiVault tests, run against the real World fixture (SetupTemplate).
 *
 * Invariants under test:
 *  1. the vault registers + owns a game account; only vault functions act as owner
 *  2. deposits stake into the vault account; withdraw returns the 721 ONLY to depositor
 *  3. settle() splits MUSU pro-rata by XP delta, minus mgmt fee, via ItemTransferSystem
 *  4. the operator CANNOT unstake or move items (game-enforced, owner-gated)
 *  5. DOCUMENTED RISK: the operator CAN KamiSend a staked kami away (game allows it)
 */
contract KamiVaultTest is SetupTemplate {
  KamiVault vault;
  address vaultOperator;

  uint16 constant MGMT_BPS = 1500; // 15%

  function setUp() public override {
    super.setUp();

    vaultOperator = _getNextUserAddress();
    vault = new KamiVault(world, _Kami721, MGMT_BPS);
    vault.initialize(vaultOperator, "vault");
    vault.setMgmtAccount(charlie.id); // charlie plays the platform's game account

    // NOTE: pre-existing gap in this repo snapshot's test deploy — the harvest systems
    // were never authorized as writers on TimeComponent (the stock Harvest.t.sol suite
    // fails identically). Grant it here so harvest flows work; not a vault concern.
    vm.startPrank(deployer);
    _TimeComponent.authorizeWriter(address(_HarvestStartSystem));
    _TimeComponent.authorizeWriter(address(_HarvestCollectSystem));
    _TimeComponent.authorizeWriter(address(_HarvestStopSystem));
    vm.stopPrank();
  }

  /////////////////
  // HELPERS

  /// @dev mint a kami to a player, bridge it out, deposit + stake it into the vault
  function _depositToVault(PlayerAccount memory acc, uint256 kamiID) internal returns (uint32) {
    _unstakeKami(kamiID); // template helper: 721 -> acc.owner EOA
    uint32 tokenIndex = LibKami.getIndex(components, kamiID);

    vm.startPrank(acc.owner);
    _Kami721.approve(address(vault), uint256(tokenIndex));
    vault.deposit(tokenIndex);
    vm.stopPrank();

    _stakeIntoVault(tokenIndex);
    return tokenIndex;
  }

  function _stakeIntoVault(uint32 tokenIndex) internal {
    uint32 room = LibAccount.getRoom(components, vault.accID());
    _setVaultRoom(uint32(BRIDGE_721_ROOM));
    uint32[] memory idxs = new uint32[](1);
    idxs[0] = tokenIndex;
    vault.stakeDeposits(idxs);
    _setVaultRoom(room == 0 ? 1 : room);
  }

  function _setVaultRoom(uint32 room) internal {
    uint256 id = vault.accID(); // read BEFORE prank — the staticcall would consume it
    vm.prank(deployer);
    _IndexRoomComponent.set(id, room);
  }

  /// @dev run a harvest on a vault kami with a deterministic injected bounty
  function _vaultHarvest(uint256 kamiID, uint256 bounty) internal {
    _fastForward(_idleRequirement);
    vm.prank(vaultOperator);
    bytes memory raw = _HarvestStartSystem.executeTyped(kamiID, 1, 0, 0);
    uint256 prodID = abi.decode(raw, (uint256));

    _incHarvestBounty(prodID, bounty);

    _fastForward(_idleRequirement);
    vm.prank(vaultOperator);
    _HarvestStopSystem.executeTyped(prodID); // collect + stop, kami back to RESTING
  }

  function _accountMusu(PlayerAccount memory acc) internal view returns (uint256) {
    return LibInventory.getBalanceOf(components, acc.id, MUSU_INDEX);
  }

  /////////////////
  // SETUP / CUSTODY

  function testVaultOwnsAccount() public {
    uint256 accID = vault.accID();
    assertTrue(accID != 0, "no account");
    assertEq(LibAccount.getByOwner(components, address(vault)), accID, "owner mismatch");
    assertEq(LibAccount.getOperator(components, accID), vaultOperator, "operator mismatch");
  }

  function testDepositStakesKamiIntoVaultAccount() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _depositToVault(alice, kamiID);

    // 721 custodied by the Kami721 contract while staked; in-world owner = vault account
    assertEq(_Kami721.ownerOf(uint256(tokenIndex)), address(_Kami721), "721 custody");
    assertEq(LibKami.getAccount(components, kamiID), vault.accID(), "in-world owner");
    assertEq(vault.numDeposits(), 1, "deposit count");
  }

  function testWithdrawReturnsOnlyToDepositor() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _depositToVault(alice, kamiID);

    // bob (nor the admin) cannot withdraw alice's kami
    vm.prank(bob.owner);
    vm.expectRevert("KamiVault: not depositor");
    vault.withdraw(tokenIndex);

    vm.expectRevert("KamiVault: not depositor"); // admin == this test contract
    vault.withdraw(tokenIndex);

    // alice withdraws: kami must be RESTING + vault account in bridge room
    _setVaultRoom(uint32(BRIDGE_721_ROOM));
    vm.prank(alice.owner);
    vault.withdraw(tokenIndex);

    assertEq(_Kami721.ownerOf(uint256(tokenIndex)), alice.owner, "721 not returned");
    assertEq(vault.numDeposits(), 0, "deposit not cleared");
  }

  /////////////////
  // SETTLEMENT

  function testSettleSingleDepositor() public {
    uint256 kamiID = _mintKami(alice);
    _depositToVault(alice, kamiID);

    _vaultHarvest(kamiID, 100_000);

    uint256 vaultBal = vault.musuBalance();
    assertTrue(vaultBal >= 100_000, "vault did not accrue musu");

    uint256 aliceBefore = _accountMusu(alice);
    uint256 charlieBefore = _accountMusu(charlie);

    // expected math, mirroring the contract
    uint256 feeBudget = (1 + 0 + 1) * TRANSFER_FEE;
    uint256 distributable = vaultBal - feeBudget; // reserve = 0
    uint256 mgmtCut = (distributable * MGMT_BPS) / 10000;
    uint256 payout = distributable - mgmtCut; // single depositor: full pool

    vault.settle();

    assertEq(_accountMusu(alice) - aliceBefore, payout, "alice payout");
    assertEq(_accountMusu(charlie) - charlieBefore, mgmtCut, "mgmt cut");
  }

  function testSettleTwoDepositorsProRata() public {
    uint256 aKami = _mintKami(alice);
    uint256 bKami = _mintKami(bob);
    _depositToVault(alice, aKami);
    _depositToVault(bob, bKami);

    // alice's kami earns ~3x bob's
    _vaultHarvest(aKami, 300_000);
    _vaultHarvest(bKami, 100_000);

    uint256 aDelta = vault.pendingXpDelta(LibKami.getIndex(components, aKami));
    uint256 bDelta = vault.pendingXpDelta(LibKami.getIndex(components, bKami));
    uint256 totalDelta = aDelta + bDelta;
    assertTrue(aDelta > bDelta, "attribution ordering");

    uint256 vaultBal = vault.musuBalance();
    uint256 feeBudget = (2 + 0 + 1) * TRANSFER_FEE;
    uint256 distributable = vaultBal - feeBudget;
    uint256 mgmtCut = (distributable * MGMT_BPS) / 10000;
    uint256 pool = distributable - mgmtCut;

    uint256 aBefore = _accountMusu(alice);
    uint256 bBefore = _accountMusu(bob);

    vault.settle();

    assertEq(_accountMusu(alice) - aBefore, (pool * aDelta) / totalDelta, "alice share");
    assertEq(_accountMusu(bob) - bBefore, (pool * bDelta) / totalDelta, "bob share");
  }

  function testWithdrawCarriesUnsettledXp() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _depositToVault(alice, kamiID);

    _vaultHarvest(kamiID, 100_000);

    // withdraw before settle: XP delta must be carried, not lost
    _setVaultRoom(uint32(BRIDGE_721_ROOM));
    vm.prank(alice.owner);
    vault.withdraw(tokenIndex);
    _setVaultRoom(1);

    assertTrue(vault.carryDelta(alice.owner) > 0, "carry not recorded");

    uint256 aliceBefore = _accountMusu(alice);
    vault.settle();
    assertTrue(_accountMusu(alice) > aliceBefore, "carried earnings not paid");
    assertEq(vault.carryDelta(alice.owner), 0, "carry not cleared");
  }

  function testSettleNoEarningsIsNoop() public {
    uint256 kamiID = _mintKami(alice);
    _depositToVault(alice, kamiID);

    // fund the vault account without any harvest (no XP delta anywhere)
    vm.startPrank(deployer);
    LibInventory.incFor(components, vault.accID(), MUSU_INDEX, 50_000);
    vm.stopPrank();

    uint256 aliceBefore = _accountMusu(alice);
    vault.settle(); // totalDelta == 0 -> no distribution
    assertEq(_accountMusu(alice), aliceBefore, "should not distribute without earnings");
  }

  function testDeferredPayoutStaysSolventAcrossSettlementsAndClaimsNetOfFee() public {
    address lateRegistrant = _getNextUserAddress();
    uint256 kamiID = _mintKami(alice);
    _unstakeKami(kamiID);
    uint32 tokenIndex = LibKami.getIndex(components, kamiID);

    vm.prank(alice.owner);
    _Kami721.transferFrom(alice.owner, lateRegistrant, uint256(tokenIndex));
    vm.startPrank(lateRegistrant);
    _Kami721.approve(address(vault), uint256(tokenIndex));
    vault.deposit(tokenIndex);
    vm.stopPrank();
    _stakeIntoVault(tokenIndex);

    _vaultHarvest(kamiID, 100_000);
    vault.settle();

    uint256 firstGross = vault.owedMusu(lateRegistrant);
    assertGt(firstGross, TRANSFER_FEE, "deferred gross must fund its claim fee");
    assertEq(vault.owedMusuTotal(), firstGross, "aggregate liability mismatch");
    assertGe(vault.musuBalance(), firstGross, "first settlement insolvent");

    // A later settlement must treat the first gross claim as reserved money,
    // not as new revenue that can be allocated a second time.
    _vaultHarvest(kamiID, 80_000);
    vault.settle();

    uint256 totalGross = vault.owedMusu(lateRegistrant);
    assertGt(totalGross, firstGross, "second earning not accrued");
    assertEq(vault.owedMusuTotal(), totalGross, "aggregate liability double-counted");
    assertGe(vault.musuBalance(), totalGross, "repeat settlement spent a liability");

    vm.prank(lateRegistrant);
    _AccountRegisterSystem.executeTyped(lateRegistrant, "late-registrant");
    uint256 target = uint256(uint160(lateRegistrant));
    uint256 recipientBefore = LibInventory.getBalanceOf(components, target, MUSU_INDEX);
    uint256 vaultBefore = vault.musuBalance();

    vm.prank(lateRegistrant);
    vault.claimOwed();

    assertEq(
      LibInventory.getBalanceOf(components, target, MUSU_INDEX) - recipientBefore,
      totalGross - TRANSFER_FEE,
      "claimant net payout"
    );
    assertEq(vaultBefore - vault.musuBalance(), totalGross, "claim consumed another user's funds");
    assertEq(vault.owedMusu(lateRegistrant), 0, "claim not cleared");
    assertEq(vault.owedMusuTotal(), 0, "aggregate liability not cleared");
  }

  /////////////////
  // ADMIN BOUNDARIES

  function testMgmtBpsOnlyLowers() public {
    vm.expectRevert("KamiVault: can only lower");
    vault.lowerMgmtBps(MGMT_BPS + 1);

    vault.lowerMgmtBps(1000);
    assertEq(vault.mgmtBps(), 1000);

    vm.prank(alice.owner);
    vm.expectRevert("KamiVault: not admin");
    vault.lowerMgmtBps(500);
  }

  /////////////////
  // OPERATOR BOUNDARIES (game-enforced)

  function testOperatorCannotUnstake() public {
    uint256 kamiID = _mintKami(alice);
    uint32 tokenIndex = _depositToVault(alice, kamiID);

    _setVaultRoom(uint32(BRIDGE_721_ROOM));
    vm.prank(vaultOperator);
    vm.expectRevert(); // operator address has no account as OWNER
    _Kami721UnstakeSystem.executeTyped(tokenIndex);
  }

  function testOperatorCannotTransferItems() public {
    uint256 kamiID = _mintKami(alice);
    _depositToVault(alice, kamiID);
    _vaultHarvest(kamiID, 100_000);

    uint32[] memory indices = new uint32[](1);
    uint256[] memory amts = new uint256[](1);
    indices[0] = MUSU_INDEX;
    amts[0] = 1000;

    vm.prank(vaultOperator);
    vm.expectRevert(); // ItemTransferSystem is owner-gated
    _ItemTransferSystem.executeTyped(indices, amts, uint256(uint160(vaultOperator)));
  }

  /// @notice DOCUMENTED RISK: a compromised operator key CAN send staked kamis to
  /// another account (KamiSendSystem is operator-gated). This is why the operator key
  /// lives only with the automation provider and rotateOperator() exists.
  function testDocumentedRisk_OperatorCanSendKamiAway() public {
    uint256 kamiID = _mintKami(alice);
    _depositToVault(alice, kamiID);
    uint32 tokenIndex = LibKami.getIndex(components, kamiID);

    vm.prank(vaultOperator);
    _KamiSendSystem.executeTyped(tokenIndex, bob.operator);

    // the kami now belongs to bob's account — theft, if the operator were malicious
    assertEq(LibKami.getAccount(components, kamiID), bob.id, "risk no longer reproduces?");
  }

  /////////////////
  // KILL SWITCH

  function testRotateOperator() public {
    address newOp = _getNextUserAddress();
    vault.rotateOperator(newOp);
    assertEq(LibAccount.getOperator(components, vault.accID()), newOp);

    // old operator is fully cut off
    uint256 kamiID = _mintKami(alice);
    _depositToVault(alice, kamiID);
    _fastForward(_idleRequirement);
    vm.prank(vaultOperator);
    vm.expectRevert();
    _HarvestStartSystem.executeTyped(kamiID, 1, 0, 0);
  }
}
