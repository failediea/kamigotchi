// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

/**
 * @title PersonalRentalPoolRegistry
 * @notice Append-only registry of pools created by one immutable factory.
 *
 * The temporary installer can set the factory exactly once during coordinated
 * deployment. Setting it burns the installer authority. Afterwards the only
 * state change is factory registration of a new pool and its immutable human
 * beneficiary; there is no admin, removal, replacement, pause or rescue path.
 */
contract PersonalRentalPoolRegistry {
    address public installer;
    address public factory;

    mapping(address => bool) public isPool;
    mapping(address => address) public poolOwner;

    error AlreadyConfigured();
    error InvalidFactory();
    error InvalidPool();
    error NotFactory();
    error NotInstaller();

    event FactorySealed(address indexed factory);
    event PoolRegistered(address indexed pool, address indexed owner);

    constructor(address _installer) {
        if (_installer == address(0)) revert NotInstaller();
        installer = _installer;
    }

    function setFactory(address newFactory) external {
        if (msg.sender != installer) revert NotInstaller();
        if (factory != address(0)) revert AlreadyConfigured();
        if (newFactory.code.length == 0) revert InvalidFactory();
        factory = newFactory;
        installer = address(0);
        emit FactorySealed(newFactory);
    }

    function registerPool(address pool, address owner) external {
        if (msg.sender != factory) revert NotFactory();
        if (pool.code.length == 0 || owner == address(0) || isPool[pool]) revert InvalidPool();
        isPool[pool] = true;
        poolOwner[pool] = owner;
        emit PoolRegistered(pool, owner);
    }
}
