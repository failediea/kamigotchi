// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import {IWorld} from "solecs/interfaces/IWorld.sol";
import {IUint256Component as IUintComp} from "solecs/interfaces/IUint256Component.sol";
import {getAddrByID} from "solecs/utils.sol";

import {AccountRegisterSystem, ID as AccountRegisterSystemID} from "systems/AccountRegisterSystem.sol";
import {KamiSendSystem, ID as KamiSendSystemID} from "systems/KamiSendSystem.sol";

import {LibAccount} from "libraries/LibAccount.sol";
import {LibKami} from "libraries/LibKami.sol";
import {LibStat} from "libraries/LibStat.sol";
import {Stat} from "solecs/components/types/Stat.sol";

interface IPersonalPoolMarket {
    function operatorAddr() external view returns (address);
    function listingBeneficiary(uint32 tokenIndex) external view returns (address);
    function listKami(
        uint32 tokenIndex,
        uint16 ownerShareBps,
        uint128 minDeposit,
        uint32 maxTermSecs,
        address reservedFor
    ) external;
    function delist(uint32 tokenIndex) external;
    function requestReturn(uint32 tokenIndex) external;
    function finalizeLease(uint32 tokenIndex) external;
}

/**
 * @title PersonalRentalPool
 * @notice One owner's contract-operated holding account for Kamis offered on a
 * shared KamiLeaseMarket.
 *
 * This contract deliberately CANNOT farm, transfer items, change its operator,
 * change its owner, upgrade, pause, or rescue to an arbitrary address. Its only
 * outbound KamiSend destinations are:
 *   1. the configured market hub when a renter accepts; and
 *   2. the immutable owner's verified current game-account operator on withdrawal.
 *
 * Kamibots never touches this account. Accepted rentals leave this pool for the
 * shared market hub and the renter's newly provisioned dedicated RoomPod,
 * where Kamibots performs the farming with gas funded by that renter.
 */
contract PersonalRentalPool {
    struct Init {
        address factory;
        address world;
        address vault;
        address vaultOwner;
        address market;
        uint16 ownerShareBps;
        uint32 maxTermSecs;
        string accountName;
    }

    struct LocalListing {
        uint256 kamiID;
        bool arrived;
        bool published;
        bool released;
    }

    uint64 public constant MIN_TERM = 1 days;
    uint64 public constant MAX_TERM = 30 days;

    IWorld public world;
    address public factory;
    address public vault;
    address public vaultOwner;
    address public market;
    uint256 public accID;
    uint16 public ownerShareBps;
    uint32 public maxTermSecs;

    mapping(uint32 => LocalListing) internal _listings;
    uint32[] public tokenIndices;
    mapping(uint32 => uint256) internal tokenPos;

    bool private initialized;
    uint256 private locked;

    error AlreadyArrived();
    error AlreadyInitialized();
    error AlreadyListed();
    error EmptyName();
    error InvalidConfig();
    error InvalidTerms();
    error KamiNotInOwnerAccount();
    error KamiNotInPool();
    error NameTooLong();
    error NotFactory();
    error NotListed();
    error NotMarket();
    error NotOwner();
    error NotRestedFull();
    error Published();
    error Reentrancy();
    error WrongOwnerOperator();

    event Initialized(uint256 indexed accID, address indexed owner, address indexed market, string accountName);
    event ListingDeclared(uint32 indexed tokenIndex, uint256 indexed kamiID);
    event ListingPublished(uint32 indexed tokenIndex, address indexed market);
    event ReleasedToMarket(uint32 indexed tokenIndex, address indexed marketOperator);
    event ReturnedToPool(uint32 indexed tokenIndex);
    event ReturnRequested(uint32 indexed tokenIndex);
    event LeaseFinalized(uint32 indexed tokenIndex);
    event ListingCancelled(uint32 indexed tokenIndex);
    event WithdrawnToOwner(uint32 indexed tokenIndex, address indexed ownerOperator);

    modifier onlyOwner() {
        if (msg.sender != vaultOwner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    constructor() {
        initialized = true;
    }

    function initialize(Init calldata cfg) external {
        if (initialized) revert AlreadyInitialized();
        if (msg.sender != cfg.factory) revert NotFactory();
        if (
            cfg.factory == address(0) || cfg.vault == address(0) || cfg.vaultOwner == address(0)
                || cfg.market.code.length == 0
        ) revert InvalidConfig();
        if (cfg.ownerShareBps > 10_000) revert InvalidTerms();
        if (cfg.maxTermSecs < MIN_TERM || cfg.maxTermSecs > MAX_TERM) revert InvalidTerms();
        uint256 nameLength = bytes(cfg.accountName).length;
        if (nameLength == 0) revert EmptyName();
        if (nameLength > 16) revert NameTooLong();

        initialized = true;
        locked = 1;
        factory = cfg.factory;
        world = IWorld(cfg.world);
        vault = cfg.vault;
        vaultOwner = cfg.vaultOwner;
        market = cfg.market;
        ownerShareBps = cfg.ownerShareBps;
        maxTermSecs = cfg.maxTermSecs;

        bytes memory result = AccountRegisterSystem(_sys(AccountRegisterSystemID)).executeTyped(
            address(this), cfg.accountName
        );
        accID = abi.decode(result, (uint256));
        emit Initialized(accID, vaultOwner, market, cfg.accountName);
    }

    /**
     * @notice Step 1: the owner declares a Kami while it is still in their own
     * game account. They then use the normal game UI to send it to this pool's
     * contract address (the pool is its own operator).
     */
    function declareKami(uint32 tokenIndex) external onlyOwner {
        if (tokenPos[tokenIndex] != 0) revert AlreadyListed();
        uint256 kamiID = LibKami.getByIndex(_comps(), tokenIndex);
        uint256 holder = LibKami.getAccount(_comps(), kamiID);
        // Accept a kami that has ALREADY arrived here, not just one still in the
        // owner's account. The documented order is declare-then-send, but the
        // pool's address is a valid in-game send target, so sending first was one
        // slip away — and it was unrecoverable: declareKami rejected it (no longer
        // the owner's) while withdrawToOwner needs a listing only declareKami can
        // create. A contract that advertises no rescue path must not need one.
        bool alreadyHere = holder == accID;
        if (holder != uint256(uint160(vaultOwner)) && !alreadyHere) {
            revert KamiNotInOwnerAccount();
        }
        if (!_isRestedFull(kamiID)) revert NotRestedFull();

        _listings[tokenIndex] =
            LocalListing({kamiID: kamiID, arrived: alreadyHere, published: false, released: false});
        tokenIndices.push(tokenIndex);
        tokenPos[tokenIndex] = tokenIndices.length;
        emit ListingDeclared(tokenIndex, kamiID);
    }

    /**
     * @notice Step 2: after the in-game send arrives, publish the listing to the
     * shared market. The Kami remains in this owner-specific pool until rented.
     */
    function confirmAndPublish(uint32 tokenIndex, address reservedFor) external onlyOwner nonReentrant {
        LocalListing storage l = _listing(tokenIndex);
        if (l.published) revert Published();
        if (LibKami.getAccount(_comps(), l.kamiID) != accID) revert KamiNotInPool();
        if (!_isRestedFull(l.kamiID)) revert NotRestedFull();

        l.arrived = true;
        l.released = false;
        IPersonalPoolMarket(market).listKami(tokenIndex, ownerShareBps, 0, maxTermSecs, reservedFor);
        l.published = true;
        emit ListingPublished(tokenIndex, market);
    }

    /**
     * @notice Called only by the configured market during acceptLease. This is
     * the only path from idle owner custody into the platform farming system.
     */
    function releaseToMarket(uint32 tokenIndex) external nonReentrant {
        if (msg.sender != market) revert NotMarket();
        LocalListing storage l = _listing(tokenIndex);
        if (!l.published) revert NotListed();
        if (LibKami.getAccount(_comps(), l.kamiID) != accID) revert KamiNotInPool();

        address hubOperator = IPersonalPoolMarket(market).operatorAddr();
        KamiSendSystem(_sys(KamiSendSystemID)).executeTyped(tokenIndex, hubOperator);
        l.released = true;
        emit ReleasedToMarket(tokenIndex, hubOperator);
    }

    /**
     * @notice Sync local state after the ops bot has returned a completed rental
     * to this pool and the global market has cleared it.
     */
    function syncReturned(uint32 tokenIndex) external {
        LocalListing storage l = _listing(tokenIndex);
        if (LibKami.getAccount(_comps(), l.kamiID) != accID) revert KamiNotInPool();
        if (IPersonalPoolMarket(market).listingBeneficiary(tokenIndex) != address(0)) revert Published();
        l.arrived = true;
        l.published = false;
        l.released = false;
        emit ReturnedToPool(tokenIndex);
    }

    /**
     * @notice Cancel an idle published listing but keep the Kami in this pool.
     * Active or already-released rentals are rejected by the global market.
     */
    function cancelListing(uint32 tokenIndex) external onlyOwner nonReentrant {
        LocalListing storage l = _listing(tokenIndex);
        if (!l.published) revert NotListed();
        IPersonalPoolMarket(market).delist(tokenIndex);
        l.published = false;
        l.released = false;
        emit ListingCancelled(tokenIndex);
    }

    /**
     * @notice Ask the global market to return an active rental. The global
     * market enforces that a paid term cannot be cut short by the owner.
     */
    function requestReturn(uint32 tokenIndex) external onlyOwner nonReentrant {
        LocalListing storage l = _listing(tokenIndex);
        if (!l.published) revert NotListed();
        IPersonalPoolMarket(market).requestReturn(tokenIndex);
        emit ReturnRequested(tokenIndex);
    }

    /**
     * @notice Owner recovery path if the keeper has not finalized an ending
     * lease after the global market's grace period. The market still enforces
     * the timeout and requires harvesting to have stopped.
     */
    function finalizeLease(uint32 tokenIndex) external onlyOwner nonReentrant {
        LocalListing storage l = _listing(tokenIndex);
        if (!l.published) revert NotListed();
        IPersonalPoolMarket(market).finalizeLease(tokenIndex);
        emit LeaseFinalized(tokenIndex);
    }

    /**
     * @notice Withdraw an idle or returned Kami only to the immutable owner's
     * current game account. The owner supplies their current operator address;
     * it is resolved and verified on-chain before the send.
     */
    function withdrawToOwner(uint32 tokenIndex, address ownerOperator) external onlyOwner nonReentrant {
        LocalListing memory l = _listing(tokenIndex);
        if (LibKami.getAccount(_comps(), l.kamiID) != accID) revert KamiNotInPool();
        if (l.published) IPersonalPoolMarket(market).delist(tokenIndex);

        uint256 ownerAccID = LibAccount.getByOperator(_comps(), ownerOperator);
        if (ownerAccID != uint256(uint160(vaultOwner))) revert WrongOwnerOperator();
        KamiSendSystem(_sys(KamiSendSystemID)).executeTyped(tokenIndex, ownerOperator);
        _removeListing(tokenIndex);
        emit WithdrawnToOwner(tokenIndex, ownerOperator);
    }

    function listings(uint32 tokenIndex) external view returns (LocalListing memory) {
        return _listing(tokenIndex);
    }

    function numListings() external view returns (uint256) {
        return tokenIndices.length;
    }

    function kamiInPool(uint32 tokenIndex) external view returns (bool) {
        uint256 kamiID = LibKami.getByIndex(_comps(), tokenIndex);
        return LibKami.getAccount(_comps(), kamiID) == accID;
    }

    function operatorAddr() external view returns (address) {
        return address(this);
    }

    function _listing(uint32 tokenIndex) internal view returns (LocalListing storage l) {
        if (tokenPos[tokenIndex] == 0) revert NotListed();
        l = _listings[tokenIndex];
    }

    function _removeListing(uint32 tokenIndex) internal {
        uint256 pos = tokenPos[tokenIndex];
        if (pos == 0) revert NotListed();
        uint256 last = tokenIndices.length;
        if (pos != last) {
            uint32 moved = tokenIndices[last - 1];
            tokenIndices[pos - 1] = moved;
            tokenPos[moved] = pos;
        }
        tokenIndices.pop();
        delete tokenPos[tokenIndex];
        delete _listings[tokenIndex];
    }

    function _isRestedFull(uint256 kamiID) internal view returns (bool) {
        IUintComp comps = _comps();
        if (!LibKami.isState(comps, kamiID, "RESTING")) return false;
        Stat memory hp = LibStat.get(comps, "HEALTH", kamiID);
        int32 total = LibStat.getTotal(comps, "HEALTH", kamiID);
        if (hp.sync >= total) return true;
        uint256 recovered = LibKami.calcRecovery(comps, kamiID);
        return int256(hp.sync) + int256(recovered) >= int256(total);
    }

    function _sys(uint256 id) internal view returns (address) {
        return getAddrByID(world.systems(), id);
    }

    function _comps() internal view returns (IUintComp) {
        return world.components();
    }
}
