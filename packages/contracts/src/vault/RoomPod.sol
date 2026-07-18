// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import { IWorld } from "solecs/interfaces/IWorld.sol";
import { IUint256Component as IUintComp } from "solecs/interfaces/IUint256Component.sol";
import { getAddrByID } from "solecs/utils.sol";

import { AccountRegisterSystem, ID as AccountRegisterSystemID } from "systems/AccountRegisterSystem.sol";
import { AccountSetOperatorSystem, ID as AccountSetOperatorSystemID } from "systems/AccountSetOperatorSystem.sol";
import { ItemTransferSystem, ID as ItemTransferSystemID } from "systems/ItemTransferSystem.sol";
import { LibInventory, MUSU_INDEX, TRANSFER_FEE } from "libraries/LibInventory.sol";

interface IHub {
  function accID() external view returns (uint256);
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
 *  - kami movement is operator-gated in-game; the pod contract exposes NO kami
 *    functions at all, so even a malicious admin cannot redirect a kami here
 *  - money path is ONE-WAY: sweepMusu() pushes this account's MUSU to the HUB
 *    account (hard-wired, anyone may call), where settle() pays owners/renters.
 *    No other outflow exists. ItemTransfer is owner-gated in-game, so the pod's
 *    operator cannot move funds either.
 *  - rotateOperator() is the per-pod kill switch: one compromised pod operator
 *    never touches the hub pool or any other pod.
 */
contract RoomPod {
  IWorld public immutable world;
  IHub public immutable hub;
  uint32 public immutable nodeIndex; // the tile this pod farms, forever

  address public admin;
  uint256 public accID; // this pod's game account
  string public label; // human tile name, e.g. "Misty Riverside (EERIE)"

  event Initialized(uint256 accID, address operator, string name);
  event OperatorRotated(address newOperator);
  event Swept(uint256 amount);

  modifier onlyAdmin() {
    require(msg.sender == admin, "Pod: not admin");
    _;
  }

  constructor(IWorld _world, address _hub, uint32 _nodeIndex, string memory _label) {
    world = _world;
    hub = IHub(_hub);
    nodeIndex = _nodeIndex;
    label = _label;
    admin = msg.sender;
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

  /// @notice kill switch: cut this pod's automation off instantly
  function rotateOperator(address newOperator) external onlyAdmin {
    AccountSetOperatorSystem(_sys(AccountSetOperatorSystemID)).executeTyped(newOperator);
    emit OperatorRotated(newOperator);
  }

  /// @notice push ALL farmed MUSU to the hub for settlement. anyone may call;
  ///         the destination is hard-wired to the hub's game account. the
  ///         in-world transfer fee comes out of the swept amount.
  function sweepMusu() external returns (uint256 swept) {
    uint256 bal = LibInventory.getBalanceOf(_comps(), accID, MUSU_INDEX);
    if (bal <= TRANSFER_FEE) return 0;
    swept = bal - TRANSFER_FEE;

    uint32[] memory indices = new uint32[](1);
    uint256[] memory amts = new uint256[](1);
    indices[0] = MUSU_INDEX;
    amts[0] = swept;
    ItemTransferSystem(_sys(ItemTransferSystemID)).executeTyped(indices, amts, hub.accID());
    emit Swept(swept);
  }

  function musuBalance() external view returns (uint256) {
    return LibInventory.getBalanceOf(_comps(), accID, MUSU_INDEX);
  }

  function _sys(uint256 id) internal view returns (address) {
    return getAddrByID(world.systems(), id);
  }

  function _comps() internal view returns (IUintComp) {
    return world.components();
  }
}
