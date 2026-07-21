// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

interface IPersonalRentalVaultFactory {
    function deployPool(address market, uint16 ownerShareBps, uint32 maxTermSecs, string calldata accountName)
        external
        returns (address pool);
}

/**
 * @title PersonalRentalVault
 * @notice Immutable owner registry for that owner's Personal Rental Pools.
 * The owner cannot be replaced and neither the platform nor the factory has an
 * admin, upgrade, pause, rescue, or arbitrary-send role.
 */
contract PersonalRentalVault {
    address public immutable factory;
    address public immutable owner;
    string public label;

    address[] internal _pools;
    mapping(address => bool) public isPool;

    error NotFactory();
    error NotOwner();

    event PoolCreated(address indexed pool, address indexed market, uint16 ownerShareBps, uint32 maxTermSecs);

    constructor(address _factory, address _owner, string memory _label) {
        factory = _factory;
        owner = _owner;
        label = _label;
    }

    function createPool(address market, uint16 ownerShareBps, uint32 maxTermSecs, string calldata accountName)
        external
        returns (address pool)
    {
        if (msg.sender != owner) revert NotOwner();
        pool = IPersonalRentalVaultFactory(factory).deployPool(market, ownerShareBps, maxTermSecs, accountName);
    }

    function registerPoolFromFactory(address pool, address market, uint16 ownerShareBps, uint32 maxTermSecs) external {
        if (msg.sender != factory) revert NotFactory();
        isPool[pool] = true;
        _pools.push(pool);
        emit PoolCreated(pool, market, ownerShareBps, maxTermSecs);
    }

    function pools() external view returns (address[] memory) {
        return _pools;
    }

    function numPools() external view returns (uint256) {
        return _pools.length;
    }
}
