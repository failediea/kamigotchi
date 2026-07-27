// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import { IWorld } from "solecs/interfaces/IWorld.sol";
import { IUint256Component as IUintComp } from "solecs/interfaces/IUint256Component.sol";
import { getAddrByID } from "solecs/utils.sol";

import { AccountRegisterSystem, ID as AccountRegisterSystemID } from "systems/AccountRegisterSystem.sol";
import { AccountSetOperatorSystem, ID as AccountSetOperatorSystemID } from "systems/AccountSetOperatorSystem.sol";
import { HarvestStopSystem, ID as HarvestStopSystemID } from "systems/HarvestStopSystem.sol";
import { ItemTransferSystem, ID as ItemTransferSystemID } from "systems/ItemTransferSystem.sol";
import { KamiOnyxReviveSystem, ID as KamiOnyxReviveSystemID } from "systems/KamiOnyxReviveSystem.sol";
import { KamiSendSystem, ID as KamiSendSystemID } from "systems/KamiSendSystem.sol";
import { LibInventory, MUSU_INDEX, TRANSFER_FEE } from "libraries/LibInventory.sol";
import { LibHarvest } from "libraries/LibHarvest.sol";
import { LibKami } from "libraries/LibKami.sol";

import { LibClone } from "solady/utils/LibClone.sol";

import { PodRecoveryOperator } from "vault/PodRecoveryOperator.sol";

interface IHub {
  function accID() external view returns (uint256);
  function listingPool(uint32 tokenIndex) external view returns (address);
  function listingKamiID(uint32 tokenIndex) external view returns (uint256);
  function mgmtBps() external view returns (uint16);
}

/**
 * @title RoomPod
 * @notice A PARKED farming account for exactly one tile (node). The lease
 * protocol's hub (KamiLeaseMarket) pools idle kamis; when a renter picks this
 * pod's tile, the kami is KamiSent HERE and farmed by this pod's automation.
 * The account never changes rooms — tiles scale horizontally by adding pods
 * (more accounts), never by walking one account around.
 *
 * Trust model (same shape as the hub):
 *  - this contract OWNS the game account; no human ever holds owner keys
 *  - kami movement is operator-gated in-game; during farming the contract has
 *    no operator authority. After a proved timeout it becomes its own operator
 *    and exposes only a return to the market's recorded Personal Rental Pool
 *  - money path is ONE-WAY: sweepMusu() pushes this account's MUSU to the HUB
 *    account (hard-wired, anyone may call), where settle() pays owners/renters.
 *    No other outflow exists. ItemTransfer is owner-gated in-game, so the pod's
 *    operator cannot move funds either.
 *  - recovery rotation targets a fresh CREATE2 PodRecoveryOperator, retryable
 *    with a new salt if the address is squatted, and irreversible once it lands
 */
contract RoomPod {
  IWorld public immutable world;
  IHub public immutable hub;
  uint32 public immutable nodeIndex;
  uint32 public immutable payItem; // the ONE item this pod sweeps to the hub // the tile this pod farms, forever
  /// @notice shared PodRecoveryOperator implementation; recovery clones from it
  address public immutable recoveryOpImpl;
  uint32 public tokenIndex;
  bool public leaseBound;

  /// @dev the deploying factory, kept separately from `admin` because recovery
  ///      zeroes admin — the terminal sweep must still work after that
  address public immutable factory;
  address public admin;
  /// @notice the address the game resolves as this account's operator once
  ///         recovery has been entered; zero beforehand
  address public recoveryOperator;
  uint256 public accID; // this pod's game account
  string public label; // human tile name, e.g. "Misty Riverside (EERIE)"
  bool public recoveryMode;

  event Initialized(uint256 accID, address operator, string name);
  event OperatorRotated(address newOperator);
  event Swept(uint256 amount);
  event FeeFloatReturned(uint256 amount);
  event RecoveryModeEntered();
  event RecoveryHarvestStopAttempt(uint256 harvestID, bool stopped);
  event ReturnedToPool(address indexed pool);
  event RecoveryRevived(uint32 indexed tokenIndex);
  event LeaseBound(uint32 indexed tokenIndex);

  modifier onlyAdmin() {
    require(msg.sender == admin, "Pod: not admin");
    _;
  }

  constructor(
    IWorld _world,
    address _hub,
    uint32 _nodeIndex,
    string memory _label,
    uint32 _payItem,
    address _recoveryOpImpl
  ) {
    world = _world;
    hub = IHub(_hub);
    nodeIndex = _nodeIndex;
    label = _label;
    admin = msg.sender;
    factory = msg.sender;
    payItem = _payItem;
    recoveryOpImpl = _recoveryOpImpl;
  }

  /// @notice One-time lease binding used by renter-created pods. Legacy shared
  /// pods can remain unbound but cannot enter the personal-lease recovery path.
  function bindLease(uint32 _tokenIndex) external onlyAdmin {
    require(!leaseBound && accID == 0, "Pod: already bound");
    tokenIndex = _tokenIndex;
    leaseBound = true;
    emit LeaseBound(_tokenIndex);
  }

  /// @notice register this pod's game account (contract-owned, like the hub's)
  function initialize(address operator, string calldata name) external onlyAdmin {
    require(accID == 0, "Pod: initialized");
    bytes memory result = AccountRegisterSystem(_sys(AccountRegisterSystemID)).executeTyped(
      operator,
      name
    );
    accID = abi.decode(result, (uint256));
    emit Initialized(accID, operator, name);
  }

  /// @notice Irreversibly cut Kamibots off after the factory's on-chain timeout.
  /// @param salt CREATE2 salt for this pod's recovery operator.
  /// @dev Rotating to `address(this)` was squattable: the game's operator
  /// namespace is a global first-come map and a pod's address is public from
  /// deployment, so anyone could claim it and permanently disarm recovery. The
  /// target is now a fresh CREATE2 address — if it is taken, the whole call
  /// reverts and the caller retries with a different salt, burning no state.
  /// Recovery mode still can never be exited.
  function enterRecoveryMode(bytes32 salt) external onlyAdmin {
    require(leaseBound, "Pod: unbound");
    require(!recoveryMode, "Pod: recovery active");
    address op = LibClone.cloneDeterministic(recoveryOpImpl, salt);
    PodRecoveryOperator(op).initialize(address(this));
    // rotate FIRST: a squatted address must revert before any state is written
    AccountSetOperatorSystem(_sys(AccountSetOperatorSystemID)).executeTyped(op);
    recoveryOperator = op;
    recoveryMode = true;
    admin = address(0);
    emit OperatorRotated(op);
    emit RecoveryModeEntered();
  }

  /// @dev Route a game call through the recovery operator so it originates from
  ///      the address the game actually resolves as this account's operator.
  function _asOperator(uint256 systemID, bytes memory data) internal returns (bytes memory) {
    return PodRecoveryOperator(recoveryOperator).exec(_sys(systemID), data);
  }

  /// @notice Permissionless retry after recovery rotation. Uses the game's
  /// allow-failure stop so a caller cannot wedge recovery while a cooldown is
  /// still active. A false result simply means retry later.
  function stopHarvestForRecovery() external returns (bool stopped) {
    require(recoveryMode, "Pod: not recovering");
    uint256 kamiID = hub.listingKamiID(tokenIndex);
    uint256 harvestID = LibHarvest.getForKami(_comps(), kamiID);
    if (harvestID == 0 || !LibKami.isState(_comps(), kamiID, "HARVESTING")) {
      emit RecoveryHarvestStopAttempt(harvestID, true);
      return true;
    }
    bytes memory result = _asOperator(
      HarvestStopSystemID,
      abi.encodeWithSelector(HarvestStopSystem.executeAllowFailure.selector, abi.encode(harvestID))
    );
    stopped = abi.decode(abi.decode(result, (bytes)), (uint256)) != 0;
    emit RecoveryHarvestStopAttempt(harvestID, stopped);
  }

  /// @notice Last-resort dead-Kami recovery using 33 Onyx already held by this
  /// pod. Anyone may fund the pod's game account with Onyx and retry; the call
  /// can revive only this bound lease's Kami and cannot move inventory out.
  function reviveWithPodOnyxForRecovery() external {
    require(recoveryMode, "Pod: not recovering");
    _asOperator(
      KamiOnyxReviveSystemID,
      abi.encodeWithSelector(KamiOnyxReviveSystem.executeTyped.selector, tokenIndex)
    );
    emit RecoveryRevived(tokenIndex);
  }

  /// @notice Return the recovered Kami only to its immutable listing pool.
  /// KamiSend itself enforces RESTING state and cooldown, so callers retry after
  /// stop/send cooldowns rather than gaining a bypass.
  function returnKamiToPool() external {
    require(recoveryMode, "Pod: not recovering");
    address pool = hub.listingPool(tokenIndex);
    require(pool != address(0), "Pod: no pool");
    // executeTyped is overloaded (single / batch), so name the exact signature
    _asOperator(
      KamiSendSystemID,
      abi.encodeWithSignature("executeTyped(uint32,address)", tokenIndex, pool)
    );
    emit ReturnedToPool(pool);
  }

  /// @notice push ALL farmed MUSU to the hub for settlement. anyone may call;
  ///         the destination is hard-wired to the hub's game account. the
  ///         in-world fee is always charged in MUSU, even for another pay item.
  function sweepMusu() external returns (uint256 swept) {
    uint256 bal = LibInventory.getBalanceOf(_comps(), accID, payItem);
    uint256 feeFromProceeds = payItem == MUSU_INDEX ? TRANSFER_FEE : 0;

    // The factory's sweep is this pod's last act, so on a non-MUSU pod it also
    // carries the unspent MUSU fee float home in the same batch. Without this,
    // every finalized pod strands whatever seed it did not burn as fees — and a
    // seed that scales with term would hand griefers a way to park the hub's
    // float in dead pods by churning cheap leases. Each index in the batch
    // costs its own in-world fee, so the float only rides along when it more
    // than covers that fee; anything smaller strands as accepted dust.
    uint256 floatReturn;
    if (msg.sender == factory && payItem != MUSU_INDEX) {
      uint256 held = feeFloat();
      uint256 fees = bal > feeFromProceeds ? 2 * TRANSFER_FEE : TRANSFER_FEE;
      if (held > fees) floatReturn = held - fees;
    }

    if (bal <= feeFromProceeds && floatReturn == 0) return 0;
    // The hub credits the FULL xp delta but only receives bal - fee, so every
    // sweep whose flat fee exceeds the management cut it accrues leaves users
    // under-backed. sweepMusu is permissionless and drains to zero, so without a
    // floor anyone could re-enter that window after every collect and grind the
    // hub insolvent 15 at a time. Require the sweep to at least pay for itself.
    //
    // The factory is exempt: its terminal sweep (lease finalization / recovery)
    // is the last one this pod will ever do, so refusing it would strand the
    // residue instead of protecting anyone. The floor exists to stop UNBOUNDED
    // repetition, which a once-per-lease call cannot cause.
    if (msg.sender != factory && bal < minSweep()) return 0;
    // A non-MUSU pod earns only payItem but the game still charges its fee in
    // MUSU, so without a seeded float the sweep can never happen and the pod's
    // whole balance strands while the hub keeps crediting the xp delta. The
    // factory seeds this at pod creation; feeFloat() lets ops see it draining.
    // A positive floatReturn already proves the float covers every fee below.
    if (payItem != MUSU_INDEX && floatReturn == 0 && feeFloat() < TRANSFER_FEE) return 0;
    swept = bal > feeFromProceeds ? bal - feeFromProceeds : 0;

    uint256 n = (swept > 0 ? 1 : 0) + (floatReturn > 0 ? 1 : 0);
    uint32[] memory indices = new uint32[](n);
    uint256[] memory amts = new uint256[](n);
    uint256 i;
    if (swept > 0) {
      indices[i] = payItem;
      amts[i] = swept;
      i++;
    }
    if (floatReturn > 0) {
      indices[i] = MUSU_INDEX;
      amts[i] = floatReturn;
    }
    ItemTransferSystem(_sys(ItemTransferSystemID)).executeTyped(indices, amts, hub.accID());
    emit Swept(swept);
    if (floatReturn > 0) emit FeeFloatReturned(floatReturn);
  }

  /// @notice MUSU this pod holds to pay its own in-world transfer fees. Only
  ///         meaningful on a non-MUSU pod, which never earns MUSU itself.
  function feeFloat() public view returns (uint256) {
    return LibInventory.getBalanceOf(_comps(), accID, MUSU_INDEX);
  }

  /// @notice How many more sweeps this pod can pay for. Max on a MUSU pod, which
  ///         funds each fee out of the proceeds it is already moving.
  function sweepsLeft() external view returns (uint256) {
    if (payItem == MUSU_INDEX) return type(uint256).max;
    return feeFloat() / TRANSFER_FEE;
  }

  /// @notice Smallest sweep whose management cut covers the in-world transfer
  ///         fee. Read from the hub because mgmtBps is lower-only: a fee cut
  ///         raises this floor, and a hardcoded constant would silently stop
  ///         protecting users the moment management took less.
  function minSweep() public view returns (uint256) {
    uint16 bps = hub.mgmtBps();
    if (bps == 0) return type(uint256).max; // no cut can ever cover the fee
    return (TRANSFER_FEE * 10000) / bps;
  }

  function musuBalance() external view returns (uint256) {
    return LibInventory.getBalanceOf(_comps(), accID, payItem);
  }

  function _sys(uint256 id) internal view returns (address) {
    return getAddrByID(world.systems(), id);
  }

  function _comps() internal view returns (IUintComp) {
    return world.components();
  }
}
