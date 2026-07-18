// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import { IWorld } from "solecs/interfaces/IWorld.sol";
import { IUint256Component as IUintComp } from "solecs/interfaces/IUint256Component.sol";
import { getAddrByID } from "solecs/utils.sol";

import { HarvestStartSystem, ID as HarvestStartSystemID } from "systems/HarvestStartSystem.sol";
import { HarvestCollectSystem, ID as HarvestCollectSystemID } from "systems/HarvestCollectSystem.sol";
import { HarvestStopSystem, ID as HarvestStopSystemID } from "systems/HarvestStopSystem.sol";
import { KamiSendSystem, ID as KamiSendSystemID } from "systems/KamiSendSystem.sol";

import { LibAccount } from "libraries/LibAccount.sol";
import { LibKami } from "libraries/LibKami.sol";

import { RoomPod } from "./RoomPod.sol";

interface IHubListings {
  function accID() external view returns (uint256);

  function listings(
    uint32
  )
    external
    view
    returns (
      address owner,
      uint256 kamiID,
      uint256 xpBase,
      uint16 ownerShareBps,
      uint128 minGasWei,
      bool staked,
      bool returning,
      address renter,
      uint256 gasBudget
    );
}

/**
 * @title HarvestGuard
 * @notice SELF-FARM lease mode: this contract IS the operator of a RoomPod's
 * game account, and it exposes exactly three actions — harvest start, collect,
 * stop — each callable ONLY by the kami's CURRENT RENTER (read live from the
 * hub, so permissions follow the lease automatically). The renter farms with
 * their own hands and their own gas; no Kamibots, no bot tax.
 *
 * What a renter CANNOT do here, mechanically: send, sacrifice, market-sell,
 * feed from pool inventory, move the account, or touch any kami that is not
 * currently leased to them. Those functions do not exist on this contract,
 * and this contract is the only holder of operator power for the pod.
 *
 * Shipping (kamis in/out) is keeper-driven and DESTINATION-CONSTRAINED:
 * a kami can only ever be shipped to the HUB pool or to its recorded OWNER.
 */
contract HarvestGuard {
  IWorld public immutable world;
  IHubListings public immutable hub;

  address public admin;
  address public keeper; // ops automation (shipping + cleanup only)
  RoomPod public pod; // set once; this guard is that pod's account operator

  mapping(uint32 => uint256) public harvestOf; // tokenIndex -> active harvest id

  event PodSet(address pod);
  event KeeperSet(address keeper);
  event HarvestStarted(uint32 indexed tokenIndex, address indexed renter, uint256 harvestID);
  event HarvestCollected(uint32 indexed tokenIndex, address indexed renter);
  event HarvestStopped(uint32 indexed tokenIndex, address indexed by);
  event Shipped(uint32 indexed tokenIndex, address targetOperator);

  modifier onlyAdmin() {
    require(msg.sender == admin, "Guard: not admin");
    _;
  }

  modifier onlyKeeper() {
    require(msg.sender == keeper || msg.sender == admin, "Guard: not keeper");
    _;
  }

  constructor(IWorld _world, address _hub, address _keeper) {
    world = _world;
    hub = IHubListings(_hub);
    keeper = _keeper;
    admin = msg.sender;
  }

  function setPod(address _pod) external onlyAdmin {
    require(address(pod) == address(0), "Guard: pod set");
    pod = RoomPod(_pod);
    emit PodSet(_pod);
  }

  function setKeeper(address _keeper) external onlyAdmin {
    keeper = _keeper;
    emit KeeperSet(_keeper);
  }

  ///////////////////
  // RENTER ACTIONS — the whole surface a renter gets

  /// @notice start harvesting YOUR leased kami on this pod's tile
  function start(uint32 tokenIndex) external returns (uint256 harvestID) {
    _verifyRenter(tokenIndex);
    uint256 kamiID = LibKami.getByIndex(_comps(), tokenIndex);
    require(LibKami.getAccount(_comps(), kamiID) == pod.accID(), "Guard: kami not in this pod");

    bytes memory raw = HarvestStartSystem(_sys(HarvestStartSystemID)).executeTyped(
      kamiID,
      pod.nodeIndex(),
      0,
      0
    );
    harvestID = abi.decode(raw, (uint256));
    harvestOf[tokenIndex] = harvestID;
    emit HarvestStarted(tokenIndex, msg.sender, harvestID);
  }

  /// @notice collect accrued output (lands in the pod; paid out at settle)
  function collect(uint32 tokenIndex) external {
    _verifyRenter(tokenIndex);
    uint256 id = harvestOf[tokenIndex];
    require(id != 0, "Guard: no harvest");
    HarvestCollectSystem(_sys(HarvestCollectSystemID)).executeTyped(id);
    emit HarvestCollected(tokenIndex, msg.sender);
  }

  /// @notice stop harvesting (kami rests; also collects the final balance)
  function stop(uint32 tokenIndex) external {
    _verifyRenter(tokenIndex);
    _stop(tokenIndex);
  }

  ///////////////////
  // KEEPER ACTIONS — cleanup + constrained shipping only

  /// @notice stop an abandoned harvest once the lease is over (renter gone or
  ///         owner recalling) so the kami can rest and ship
  function keeperStop(uint32 tokenIndex) external onlyKeeper {
    (, , , , , , bool returning, address renter, ) = hub.listings(tokenIndex);
    require(renter == address(0) || returning, "Guard: lease active");
    _stop(tokenIndex);
  }

  /// @notice ship a kami out — ONLY to the hub pool or its recorded owner.
  ///         the destination is verified on-chain against the target operator's
  ///         resolved account; arbitrary destinations are impossible.
  function ship(uint32 tokenIndex, address targetOperator) external onlyKeeper {
    (address owner_, , , , , , , , ) = hub.listings(tokenIndex);
    require(owner_ != address(0), "Guard: not listed");
    uint256 targetAcc = LibAccount.getByOperator(_comps(), targetOperator);
    require(
      targetAcc == hub.accID() || targetAcc == uint256(uint160(owner_)),
      "Guard: destination not hub or owner"
    );
    KamiSendSystem(_sys(KamiSendSystemID)).executeTyped(tokenIndex, targetOperator);
    emit Shipped(tokenIndex, targetOperator);
  }

  ///////////////////
  // VIEWS

  function renterOf(uint32 tokenIndex) public view returns (address renter) {
    (, , , , , , , renter, ) = hub.listings(tokenIndex);
  }

  ///////////////////
  // INTERNALS

  function _verifyRenter(uint32 tokenIndex) internal view {
    require(renterOf(tokenIndex) == msg.sender, "Guard: not your lease");
  }

  function _stop(uint32 tokenIndex) internal {
    uint256 id = harvestOf[tokenIndex];
    require(id != 0, "Guard: no harvest");
    harvestOf[tokenIndex] = 0;
    HarvestStopSystem(_sys(HarvestStopSystemID)).executeTyped(id);
    emit HarvestStopped(tokenIndex, msg.sender);
  }

  function _sys(uint256 id) internal view returns (address) {
    return getAddrByID(world.systems(), id);
  }

  function _comps() internal view returns (IUintComp) {
    return world.components();
  }
}
