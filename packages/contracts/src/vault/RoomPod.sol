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

interface IHub {
  function accID() external view returns (uint256);
  function listingPool(uint32 tokenIndex) external view returns (address);
  function listingKamiID(uint32 tokenIndex) external view returns (uint256);
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
 *  - recovery rotation is fixed to address(this), unique per pod and irreversible
 */
contract RoomPod {
  IWorld public immutable world;
  IHub public immutable hub;
  uint32 public immutable nodeIndex;
  uint32 public immutable payItem; // the ONE item this pod sweeps to the hub // the tile this pod farms, forever
  uint32 public tokenIndex;
  bool public leaseBound;

  address public admin;
  uint256 public accID; // this pod's game account
  string public label; // human tile name, e.g. "Misty Riverside (EERIE)"
  bool public recoveryMode;

  event Initialized(uint256 accID, address operator, string name);
  event OperatorRotated(address newOperator);
  event Swept(uint256 amount);
  event RecoveryModeEntered();
  event RecoveryHarvestStopAttempt(uint256 harvestID, bool stopped);
  event ReturnedToPool(address indexed pool);
  event RecoveryRevived(uint32 indexed tokenIndex);
  event LeaseBound(uint32 indexed tokenIndex);

  modifier onlyAdmin() {
    require(msg.sender == admin, "Pod: not admin");
    _;
  }

  constructor(IWorld _world, address _hub, uint32 _nodeIndex, string memory _label, uint32 _payItem) {
    world = _world;
    hub = IHub(_hub);
    nodeIndex = _nodeIndex;
    label = _label;
    admin = msg.sender;
    payItem = _payItem;
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
  /// This pod contract is a unique operator address, avoiding the game's
  /// one-operator-to-one-account cache collision. No arbitrary replacement is
  /// accepted and recovery mode can never be exited.
  function enterRecoveryMode() external onlyAdmin {
    require(leaseBound, "Pod: unbound");
    require(!recoveryMode, "Pod: recovery active");
    recoveryMode = true;
    admin = address(0);
    AccountSetOperatorSystem(_sys(AccountSetOperatorSystemID)).executeTyped(address(this));
    emit OperatorRotated(address(this));
    emit RecoveryModeEntered();
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
    bytes memory result = HarvestStopSystem(_sys(HarvestStopSystemID)).executeAllowFailure(
      abi.encode(harvestID)
    );
    stopped = abi.decode(result, (uint256)) != 0;
    emit RecoveryHarvestStopAttempt(harvestID, stopped);
  }

  /// @notice Last-resort dead-Kami recovery using 33 Onyx already held by this
  /// pod. Anyone may fund the pod's game account with Onyx and retry; the call
  /// can revive only this bound lease's Kami and cannot move inventory out.
  function reviveWithPodOnyxForRecovery() external {
    require(recoveryMode, "Pod: not recovering");
    KamiOnyxReviveSystem(_sys(KamiOnyxReviveSystemID)).executeTyped(tokenIndex);
    emit RecoveryRevived(tokenIndex);
  }

  /// @notice Return the recovered Kami only to its immutable listing pool.
  /// KamiSend itself enforces RESTING state and cooldown, so callers retry after
  /// stop/send cooldowns rather than gaining a bypass.
  function returnKamiToPool() external {
    require(recoveryMode, "Pod: not recovering");
    address pool = hub.listingPool(tokenIndex);
    require(pool != address(0), "Pod: no pool");
    KamiSendSystem(_sys(KamiSendSystemID)).executeTyped(tokenIndex, pool);
    emit ReturnedToPool(pool);
  }

  /// @notice push ALL farmed MUSU to the hub for settlement. anyone may call;
  ///         the destination is hard-wired to the hub's game account. the
  ///         in-world fee is always charged in MUSU, even for another pay item.
  function sweepMusu() external returns (uint256 swept) {
    uint256 bal = LibInventory.getBalanceOf(_comps(), accID, payItem);
    uint256 feeFromProceeds = payItem == MUSU_INDEX ? TRANSFER_FEE : 0;
    if (bal <= feeFromProceeds) return 0;
    if (
      payItem != MUSU_INDEX
        && LibInventory.getBalanceOf(_comps(), accID, MUSU_INDEX) < TRANSFER_FEE
    ) return 0;
    swept = bal - feeFromProceeds;

    uint32[] memory indices = new uint32[](1);
    uint256[] memory amts = new uint256[](1);
    indices[0] = payItem;
    amts[0] = swept;
    ItemTransferSystem(_sys(ItemTransferSystemID)).executeTyped(indices, amts, hub.accID());
    emit Swept(swept);
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
