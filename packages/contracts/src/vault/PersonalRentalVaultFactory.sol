// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import {IWorld} from "solecs/interfaces/IWorld.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {PersonalRentalPool} from "./PersonalRentalPool.sol";
import {PersonalRentalVault} from "./PersonalRentalVault.sol";

interface IPersonalRentalPoolRegistryWriter {
    function registerPool(address pool, address owner) external;
}

interface ISealedRentalMarket {
    function world() external view returns (IWorld);
    function payItem() external view returns (uint32);
    function mgmtBps() external view returns (uint16);
    function mgmtAccID() external view returns (uint256);
    function admin() external view returns (address);
    function leaseFactory() external view returns (address);
    function poolRegistry() external view returns (address);
}

/**
 * @title PersonalRentalVaultFactory
 * @notice Permissionless, caller-funded creation of owner custody vaults/pools.
 *
 * The factory accepts only the two configured, already-sealed marketplace hubs.
 * It has no owner, admin, upgrade, pause, fee setter, keeper, key registry,
 * rescue, or emergency withdrawal function.
 */
contract PersonalRentalVaultFactory {
    uint16 public constant PLATFORM_FEE_BPS = 1_000;
    uint32 public constant MUSU_ITEM = 1;
    uint32 public constant VIPP_ITEM = 2;

    IWorld public immutable world;
    address public immutable poolImplementation;
    address public immutable musuMarket;
    address public immutable vippMarket;
    uint256 public immutable platformAccID;
    address public immutable poolRegistry;

    mapping(address => address) public vaultOf;
    mapping(address => bool) public isVault;
    mapping(address => bool) public isPool;
    address[] internal _vaults;
    address[] internal _pools;

    error AlreadyHasVault();
    error InvalidImplementation();
    error InvalidLabel();
    error InvalidMarket();
    error MarketNotSealed();
    error PlatformMismatch();
    error NotVault();

    event VaultCreated(address indexed owner, address indexed vault, string label);
    event PoolDeployed(
        address indexed vault, address indexed pool, address indexed market, uint16 ownerShareBps, uint32 maxTermSecs
    );

    constructor(
        IWorld _world,
        address _poolImplementation,
        address _musuMarket,
        address _vippMarket,
        address _poolRegistry
    ) {
        if (_poolImplementation.code.length == 0) revert InvalidImplementation();
        if (_musuMarket == address(0) && _vippMarket == address(0)) revert InvalidMarket();
        if (_poolRegistry.code.length == 0) revert InvalidMarket();

        uint256 platform;
        if (_musuMarket != address(0)) {
            platform = _validateMarket(_world, _musuMarket, MUSU_ITEM, 0, _poolRegistry);
        }
        if (_vippMarket != address(0)) {
            platform = _validateMarket(_world, _vippMarket, VIPP_ITEM, platform, _poolRegistry);
        }

        world = _world;
        poolImplementation = _poolImplementation;
        musuMarket = _musuMarket;
        vippMarket = _vippMarket;
        platformAccID = platform;
        poolRegistry = _poolRegistry;
    }

    function createVault(string calldata label) external returns (address vault) {
        vault = _createVault(msg.sender, label);
    }

    /**
     * First owner action: create their vault and first terms pool in one tx.
     */
    function createVaultWithPool(
        string calldata label,
        address market,
        uint16 ownerShareBps,
        uint32 maxTermSecs,
        string calldata accountName
    ) external returns (address vault, address pool) {
        vault = _createVault(msg.sender, label);
        pool = _deployPool(vault, msg.sender, market, ownerShareBps, maxTermSecs, accountName);
    }

    function deployPool(address market, uint16 ownerShareBps, uint32 maxTermSecs, string calldata accountName)
        external
        returns (address pool)
    {
        if (!isVault[msg.sender]) revert NotVault();
        pool = _deployPool(
            msg.sender, PersonalRentalVault(msg.sender).owner(), market, ownerShareBps, maxTermSecs, accountName
        );
    }

    function isApprovedMarket(address market) public view returns (bool) {
        return market != address(0) && (market == musuMarket || market == vippMarket);
    }

    function allVaults() external view returns (address[] memory) {
        return _vaults;
    }

    function allPools() external view returns (address[] memory) {
        return _pools;
    }

    function numVaults() external view returns (uint256) {
        return _vaults.length;
    }

    function numPools() external view returns (uint256) {
        return _pools.length;
    }

    function poolAt(uint256 index) external view returns (address) {
        return _pools[index];
    }

    function _createVault(address owner, string calldata label) internal returns (address vault) {
        if (vaultOf[owner] != address(0)) revert AlreadyHasVault();
        uint256 len = bytes(label).length;
        if (len == 0 || len > 64) revert InvalidLabel();
        vault = address(new PersonalRentalVault(address(this), owner, label));
        vaultOf[owner] = vault;
        isVault[vault] = true;
        _vaults.push(vault);
        emit VaultCreated(owner, vault, label);
    }

    function _deployPool(
        address vault,
        address vaultOwner,
        address market,
        uint16 ownerShareBps,
        uint32 maxTermSecs,
        string calldata accountName
    ) internal returns (address pool) {
        if (!isApprovedMarket(market)) revert InvalidMarket();
        // Deterministic, salted by the caller. A plain CREATE clone lands at an
        // address derived from this factory's nonce, which anyone can predict and
        // claim in the game's global operator namespace — and because the failed
        // initialize reverts without consuming the nonce, every retry landed on
        // the same squatted address. Binding the salt to msg.sender and their own
        // pool count means a squatter cannot camp the next address for everyone.
        pool = LibClone.cloneDeterministic(
            poolImplementation,
            keccak256(abi.encode(msg.sender, accountName))
        );
        PersonalRentalPool(pool)
            .initialize(
                PersonalRentalPool.Init({
                factory: address(this),
                world: address(world),
                vault: vault,
                vaultOwner: vaultOwner,
                market: market,
                ownerShareBps: ownerShareBps,
                maxTermSecs: maxTermSecs,
                accountName: accountName
            })
            );
        isPool[pool] = true;
        IPersonalRentalPoolRegistryWriter(poolRegistry).registerPool(pool, vaultOwner);
        _pools.push(pool);
        PersonalRentalVault(vault).registerPoolFromFactory(pool, market, ownerShareBps, maxTermSecs);
        emit PoolDeployed(vault, pool, market, ownerShareBps, maxTermSecs);
    }

    function _validateMarket(
        IWorld expectedWorld,
        address market,
        uint32 expectedItem,
        uint256 expectedPlatform,
        address expectedRegistry
    )
        internal
        view
        returns (uint256 platform)
    {
        if (market.code.length == 0) revert InvalidMarket();
        ISealedRentalMarket candidate = ISealedRentalMarket(market);
        if (address(candidate.world()) != address(expectedWorld)) revert InvalidMarket();
        if (candidate.payItem() != expectedItem || candidate.mgmtBps() != PLATFORM_FEE_BPS) {
            revert InvalidMarket();
        }
        if (candidate.admin() != address(0)) revert MarketNotSealed();
        if (candidate.leaseFactory().code.length == 0) revert InvalidMarket();
        if (candidate.poolRegistry() != expectedRegistry) revert InvalidMarket();
        platform = candidate.mgmtAccID();
        if (platform == 0) revert PlatformMismatch();
        if (expectedPlatform != 0 && platform != expectedPlatform) revert PlatformMismatch();
    }
}
