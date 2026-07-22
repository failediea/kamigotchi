// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import {IWorld} from "solecs/interfaces/IWorld.sol";
import {IUint256Component as IUintComp} from "solecs/interfaces/IUint256Component.sol";
import {getAddrByID} from "solecs/utils.sol";

import {KamiSendSystem, ID as KamiSendSystemID} from "systems/KamiSendSystem.sol";
import {LibAccount} from "libraries/LibAccount.sol";

interface IGuardedLeaseMarket {
    function pendingPod(uint32 tokenIndex) external view returns (address);
    function listingPool(uint32 tokenIndex) external view returns (address);
}

interface IGuardedRoomPod {
    function accID() external view returns (uint256);
}

/**
 * @title HubGuard
 * @notice Permanent operator for a non-farming market hub.
 *
 * The guard has no admin and no arbitrary destination parameter. The immutable
 * factory may route a pending Kami only to that reservation's exact RoomPod, or
 * return it only to the listing's exact registered Personal Rental Pool.
 */
contract HubGuard {
    IWorld public immutable world;
    IGuardedLeaseMarket public immutable market;
    address public immutable factory;

    error InvalidDestination();
    error NotFactory();

    event RoutedToPod(uint32 indexed tokenIndex, address indexed pod, address indexed operator);
    event ReturnedToPool(uint32 indexed tokenIndex, address indexed pool);

    constructor(IWorld _world, address _market, address _factory) {
        if (_market.code.length == 0 || _factory.code.length == 0) revert InvalidDestination();
        world = _world;
        market = IGuardedLeaseMarket(_market);
        factory = _factory;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    function routeToPendingPod(uint32 tokenIndex, address pod) external onlyFactory {
        if (pod == address(0) || market.pendingPod(tokenIndex) != pod) revert InvalidDestination();
        address operator = LibAccount.getOperator(_comps(), IGuardedRoomPod(pod).accID());
        if (operator == address(0)) revert InvalidDestination();
        KamiSendSystem(_sys(KamiSendSystemID)).executeTyped(tokenIndex, operator);
        emit RoutedToPod(tokenIndex, pod, operator);
    }

    function returnPendingToPool(uint32 tokenIndex) external onlyFactory {
        if (market.pendingPod(tokenIndex) == address(0)) revert InvalidDestination();
        address pool = market.listingPool(tokenIndex);
        if (pool == address(0)) revert InvalidDestination();
        KamiSendSystem(_sys(KamiSendSystemID)).executeTyped(tokenIndex, pool);
        emit ReturnedToPool(tokenIndex, pool);
    }

    function _sys(uint256 id) internal view returns (address) {
        return getAddrByID(world.systems(), id);
    }

    function _comps() internal view returns (IUintComp) {
        return world.components();
    }
}
