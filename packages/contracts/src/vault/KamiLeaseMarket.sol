// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import { IWorld } from "solecs/interfaces/IWorld.sol";
import { IUint256Component as IUintComp } from "solecs/interfaces/IUint256Component.sol";
import { getAddrByID } from "solecs/utils.sol";

import { AccountRegisterSystem, ID as AccountRegisterSystemID } from "systems/AccountRegisterSystem.sol";
import { ItemTransferSystem, ID as ItemTransferSystemID } from "systems/ItemTransferSystem.sol";

import { LibAccount } from "libraries/LibAccount.sol";
import { LibExperience } from "libraries/LibExperience.sol";
import { LibInventory, MUSU_INDEX, TRANSFER_FEE } from "libraries/LibInventory.sol";
import { LibKami } from "libraries/LibKami.sol";
import { LibStat } from "libraries/LibStat.sol";
import { Stat } from "solecs/components/types/Stat.sol";
import { LibEntityType } from "libraries/utils/LibEntityType.sol";

import { Kami721 } from "tokens/Kami721.sol";

interface IPersonalRentalCustody {
  function accID() external view returns (uint256);
  function releaseToMarket(uint32 tokenIndex) external;
}

interface IPersonalRentalPoolRegistry {
  function isPool(address pool) external view returns (bool);
  function poolOwner(address pool) external view returns (address);
}

interface IRenterRoomPod {
  function hub() external view returns (address);
  function accID() external view returns (uint256);
  function nodeIndex() external view returns (uint32);
  function payItem() external view returns (uint32);
}

/**
 * @title KamiLeaseMarket
 * @notice Managed-only kami lease marketplace on Yominet.
 *
 * Model:
 *  - OWNERS publish through immutable Personal Rental Pools. Idle Kamis remain
 *    in the owner's own pool, never in a shared platform custody account.
 *  - RENTERS choose a tile/strategy/term. Their single checkout transaction
 *    deploys that lease's RoomPod and funds its setup plus farming gas.
 *  - Kamibots operates only that dedicated pod. No owner/renter uploads a key,
 *    and the platform does not pre-fund pods or keep an emergency admin.
 *  - settle() splits each kami's earnings (attributed by XP delta, which increments
 *    1:1 with collected harvest output) three ways:
 *        platform fee (mgmtBps, can only be lowered)
 *        -> remainder: owner share (listing's ownerShareBps) / renter share.
 *    Earnings of an unleased-but-farmed kami go fully to the owner (minus fee).
 *  - withdrawKami() returns the NFT ONLY to the recorded owner, and only when the
 *    kami is not under an active lease. The admin cannot redirect assets; ETH gas
 *    budgets live in the immutable renter factory and can flow only to that
 *    lease's verified operators or back to its renter.
 */
contract KamiLeaseMarket {
  ///////////////////
  // TYPES

  struct Listing {
    address owner; // lessor; only address that can ever receive the kami back
    uint256 kamiID; // ECS entity
    uint256 xpBase; // attribution baseline (reset on settle / lease boundaries)
    uint16 ownerShareBps; // owner's share of post-fee earnings while leased
    uint128 minGasWei; // deprecated v13 ABI slot; personal pools always store zero
    bool staked; // true = IN THE POOL (market account custody); false = send pending
    bool returning; // owner requested an in-game send-back (blocks new leases)
    bool ending; // a party requested lease end; keeper must stop/sweep/finalize
    address renter; // active renter (0 = waiting in the pool)
    uint256 gasBudget; // deprecated v13 ABI slot; renter ETH stays in the factory
    uint32 maxTermSecs; // owner's ceiling for one lease term (MIN_TERM..MAX_TERM)
    uint64 leaseStart; // set at accept
    uint64 leaseEnd; // leaseStart + the renter's chosen term; past it ANYONE may end
    address reservedFor; // private lease: only this renter may accept (0 = public)
  }

  ///////////////////
  // STATE

  IWorld public immutable world;
  /// @notice the ONE item this market settles in (1 = MUSU, 2 = VIPP, …).
  ///         Every pod of this market sits on a node yielding exactly this item,
  ///         so XP-delta attribution stays exact per market.
  uint32 public immutable payItem;
  address public admin;
  address public leaseFactory; // fixed before seal; permissionless renter-funded pod deployer
  address public poolRegistry; // fixed before seal; append-only approved personal pools

  uint256 public accID; // the market's game account
  uint16 public mgmtBps; // platform fee, lower-only
  uint256 public mgmtAccID; // game account receiving the platform fee
  uint256 public mgmtAccrued; // platform fees accrued, awaiting transfer to mgmtAccID
  address public settler; // daily accounting + lease-finalization keeper

  mapping(uint32 => Listing) internal _listings; // by ERC721 token index
  mapping(uint32 => address) internal _listingBeneficiary; // immutable cache; no settlement callbacks
  uint32[] public tokenIndices;
  mapping(uint32 => uint256) internal tokenPos; // tokenIndex => position+1

  mapping(address => uint256) public owedMusu; // held payouts (no game account yet)
  uint256 public owedMusuTotal; // sum of owedMusu: RESERVED, never re-distributed
  mapping(address => uint256) public owedEth; // deprecated ABI compatibility; always zero in v14
  mapping(address => uint256) public participations; // active listings + leases per address
  mapping(uint32 => uint64) internal endingAt; // timeout clock for user recovery
  // Minimal reservation state only. Pod provisioning, preferences and renter
  // ETH stay in the separate factory so this market remains deployable.
  mapping(uint32 => address) public pendingRenter;
  mapping(uint32 => address) public pendingPod;

  uint64 public lastSettleAt;
  uint64 public settleCooldown = 1 days; // daily accounting cadence; admin-tunable, capped
  uint256 public settleCursor;
  bool public settlementInProgress;
  uint64 internal initializedAt;

  uint64 internal constant ENDING_GRACE = 2 days;
  uint64 internal constant SETTLER_STALE = 3 days;
  uint256 public constant MAX_SETTLE_BATCH = 50;
  // lease term rails: every lease commits for >= MIN_TERM (each cycle costs ~2h of
  // send cooldowns — sub-day rentals are all overhead) and expires by leaseEnd.
  uint64 public constant MIN_TERM = 1 days;
  uint64 public constant MAX_TERM = 30 days;

  uint256 private locked = 1;

  // compact custom errors (EIP-170 headroom) — user-facing rails keep strings
  error AlreadyEnding();
  error AlreadyInPool();
  error AlreadyLeased();
  error AlreadyListed();
  error AlreadyReturning();
  error AlreadySentHome();
  error BeingReturned();
  error BadBatch();
  error BudgetTooLow();
  error Cooldown();
  error EndLeaseFirst();
  error FeeTooHigh();
  error InPoolUseReturn();
  error AlreadyInit();
  error AdminAlreadySealed();
  error KamiNotHomeYet();
  error KamiNotInYourAccount();
  error EndingNow();
  error Leased();
  error MgmtAccountUnset();
  error NoReturnRequested();
  error NotAdmin();
  error NotFactory();
  error TermRails();
  error MinTerm();
  error Reserved();
  error TermsChanged();
  error NotRestedFull();
  error PayItemZero();
  error NotAnAccount();
  error NotArrived();
  error NotEnding();
  error NotFinalizer();
  error NotInMarket();
  error NotInPoolUseDelist();
  error NotInPoolYet();
  error NotInit();
  error NotLeased();
  error NotListed();
  error NotOwner();
  error NotParty();
  error NotRenter();
  error NotReturning();
  error NotSettler();
  error NothingClaimable();
  error NotDust();
  error OwnKami();
  error Reentrancy();
  error RegisterAnAccountFirst();
  error ShareTooHigh();
  error ZeroSettler();
  error PendingLeaseExists();
  error NoPendingLease();
  error ProvisioningRequired();
  error InvalidPool();

  ///////////////////
  // EVENTS

  event Initialized(uint256 accID, address operator, string name);
  event AdminSealed(address indexed formerAdmin);
  event SettlerSet(address newSettler);
  event LeaseFactorySet(address indexed leaseFactory);
  event PoolRegistrySet(address indexed poolRegistry);
  event Listed(address indexed owner, uint32 indexed tokenIndex, uint16 ownerShareBps, uint128 minGasWei);
  event Delisted(address indexed owner, uint32 indexed tokenIndex);
  event Arrived(address indexed owner, uint32 indexed tokenIndex); // kami joined the pool
  event ReturnRequested(address indexed owner, uint32 indexed tokenIndex); // ops bot: KamiSend it home
  event ReturnCleared(address indexed owner, uint32 indexed tokenIndex);
  event PoolRestored(address indexed owner, uint32 indexed tokenIndex);
  event LeaseAccepted(address indexed renter, uint32 indexed tokenIndex, uint256 gasBudget, string prefs);
  event LeaseProvisionRequested(
    address indexed renter,
    uint32 indexed tokenIndex,
    address indexed pod,
    uint32 nodeIndex,
    uint256 gasBudget,
    uint32 termSecs,
    string prefs
  );
  event LeasePreparing(uint32 indexed tokenIndex, address indexed pod);
  event PreparingLeaseCancelled(uint32 indexed tokenIndex, address indexed renter);
  event LeaseEnded(uint32 indexed tokenIndex, address indexed renter, uint256 gasRefund);
  event PrefsUpdated(uint32 indexed tokenIndex, address indexed renter, string prefs);
  event LeaseEnding(uint32 indexed tokenIndex, address indexed renter, address indexed requestedBy);
  event LeaseExtended(uint32 indexed tokenIndex, uint64 leaseEnd);
  event Settled(uint256 distributed, uint256 mgmtCut, uint256 totalDelta);
  event SettlementBatch(uint256 indexed from, uint256 indexed to, bool complete);
  event Payout(address indexed to, uint256 amount, bool held);
  event OwedClaimed(address indexed to, uint256 amount);
  event DustForfeited(address indexed by, uint256 amount);

  ///////////////////
  // MODIFIERS

  modifier onlyAdmin() {
    require(msg.sender == admin, NotAdmin());
    _;
  }

  modifier onlySettler() {
    require(msg.sender == settler, NotSettler());
    _;
  }

  modifier nonReentrant() {
    require(locked == 1, Reentrancy());
    locked = 2;
    _;
    locked = 1;
  }

  ///////////////////
  // SETUP / ADMIN

  constructor(IWorld _world, Kami721, uint16 _mgmtBps, uint32 _payItem) {
    require(_mgmtBps <= 3000, FeeTooHigh());
    require(_payItem != 0, PayItemZero());
    world = _world;
    admin = msg.sender;
    mgmtBps = _mgmtBps;
    payItem = _payItem;
  }

  function initialize(address operator, string calldata name) external onlyAdmin {
    require(accID == 0, AlreadyInit());
    bytes memory result = AccountRegisterSystem(_sys(AccountRegisterSystemID)).executeTyped(
      operator,
      name
    );
    accID = abi.decode(result, (uint256));
    initializedAt = uint64(block.timestamp);
    emit Initialized(accID, operator, name);
  }

  /// @notice Permanently destroys every admin/configuration power. This cannot
  ///         be reversed. Deployments must set the operator, settler, management
  ///         account, fee and cooldown first, then seal before the factory accepts
  ///         this market.
  function sealAdmin() external onlyAdmin {
    require(admin != address(0), AdminAlreadySealed());
    require(accID != 0, NotInit());
    require(settler != address(0), ZeroSettler());
    require(mgmtAccID != 0, MgmtAccountUnset());
    require(leaseFactory != address(0), NotFactory());
    require(poolRegistry != address(0), InvalidPool());
    address formerAdmin = admin;
    admin = address(0);
    emit AdminSealed(formerAdmin);
  }

  function setSettler(address newSettler) external onlyAdmin {
    require(newSettler != address(0), ZeroSettler());
    settler = newSettler;
    emit SettlerSet(newSettler);
  }

  /// @notice Set exactly once during atomic deployment, before admin sealing.
  function setLeaseFactory(address newFactory) external onlyAdmin {
    require(leaseFactory == address(0) && newFactory.code.length != 0, NotFactory());
    leaseFactory = newFactory;
    emit LeaseFactorySet(newFactory);
  }

  /// @notice Set exactly once during atomic deployment, before admin sealing.
  function setPoolRegistry(address newRegistry) external onlyAdmin {
    require(poolRegistry == address(0) && newRegistry.code.length != 0, InvalidPool());
    poolRegistry = newRegistry;
    emit PoolRegistrySet(newRegistry);
  }

  function setMgmtAccount(uint256 _mgmtAccID) external onlyAdmin {
    require(_isAccount(_mgmtAccID), NotAnAccount());
    mgmtAccID = _mgmtAccID;
  }

  // Deprecated v13 entrypoints retained only so downstream ABIs fail with a
  // clear error during migration. v14 accepts Personal Rental Pool listings
  // exclusively through the renter-funded provisioning factory.
  function confirmArrival(uint32) external pure { revert ProvisioningRequired(); }
  function listKami721(uint32, uint16, uint128, uint32, address) external pure {
    revert ProvisioningRequired();
  }
  function withdrawKami(uint32) external pure { revert ProvisioningRequired(); }
  function cancelReturn(uint32) external pure { revert ProvisioningRequired(); }
  function acceptLease(uint32, string calldata, uint16, uint32) external payable {
    revert ProvisioningRequired();
  }
  function topUpGas(uint32) external payable { revert ProvisioningRequired(); }
  function reclaimEndingGas(uint32) external pure { revert ProvisioningRequired(); }

  ///////////////////
  // OWNER SIDE (lessor) — listing SENDS the kami into the pool

  /// @notice STEP 1 of listing: declare terms. the kami must be RESTING at FULL
  ///         HEALTH and in YOUR account. STEP 2: KamiSend it to the market in-game.
  ///         Once it arrives (confirmArrival) it sits in the POOL — out of your
  ///         hands, unfarmed, waiting for a renter.
  function listKami(
    uint32 tokenIndex,
    uint16 ownerShareBps,
    uint128 minGasWei,
    uint32 maxTermSecs,
    address reservedFor
  ) external {
    require(accID != 0, NotInit());
    require(
      poolRegistry != address(0) && IPersonalRentalPoolRegistry(poolRegistry).isPool(msg.sender),
      InvalidPool()
    );
    require(ownerShareBps <= 10000, ShareTooHigh());
    require(maxTermSecs >= MIN_TERM && maxTermSecs <= MAX_TERM, TermRails());
    require(_listings[tokenIndex].owner == address(0), AlreadyListed());

    uint256 kamiID = LibKami.getByIndex(_comps(), tokenIndex);
    // the caller's game account IS uint160(caller) — verify current in-game ownership
    require(
      LibKami.getAccount(_comps(), kamiID) == uint256(uint160(msg.sender)),
      KamiNotInYourAccount()
    );
    require(_isRestedFull(kamiID), NotRestedFull());

    address beneficiary = IPersonalRentalPoolRegistry(poolRegistry).poolOwner(msg.sender);
    require(beneficiary != address(0), InvalidPool());
    _listingBeneficiary[tokenIndex] = beneficiary;
    _newListing(tokenIndex, kamiID, 0, false, ownerShareBps, minGasWei, maxTermSecs, reservedFor);
  }

  /// @dev Personal Rental Pool listing constructor.
  function _newListing(
    uint32 tokenIndex,
    uint256 kamiID,
    uint256 xpBase,
    bool staked,
    uint16 ownerShareBps,
    uint128 minGasWei,
    uint32 maxTermSecs,
    address reservedFor
  ) internal {
    _listings[tokenIndex] = Listing({
      owner: msg.sender,
      kamiID: kamiID,
      xpBase: xpBase,
      ownerShareBps: ownerShareBps,
      minGasWei: minGasWei,
      staked: staked,
      returning: false,
      ending: false,
      renter: address(0),
      gasBudget: 0,
      maxTermSecs: maxTermSecs,
      leaseStart: 0,
      leaseEnd: 0,
      reservedFor: reservedFor
    });
    tokenIndices.push(tokenIndex);
    tokenPos[tokenIndex] = tokenIndices.length;
    participations[msg.sender]++;
    emit Listed(msg.sender, tokenIndex, ownerShareBps, minGasWei);
  }

  /// @notice cancel a listing whose kami was never sent (nothing to return)
  function delist(uint32 tokenIndex) external {
    Listing memory l = _listings[tokenIndex];
    require(l.owner == msg.sender, NotOwner());
    require(l.renter == address(0), Leased());
    require(pendingRenter[tokenIndex] == address(0), PendingLeaseExists());
    require(!l.staked, InPoolUseReturn());
    if (participations[l.owner] > 0) participations[l.owner]--;
    _removeListing(tokenIndex);
    emit Delisted(msg.sender, tokenIndex);
  }

  // Pool terms are immutable. Owners create a separate terms pool instead of
  // mutating listings that renters may already be viewing.
  function updateTerms(uint32, uint16, uint128, uint32, address) external pure {
    revert ProvisioningRequired();
  }

  /// @notice PREFERRED exit: request an in-game send-back. Snapshots earnings, blocks
  ///         new leases, and signals the automation to KamiSend the kami home — no
  ///         bridge room, works from anywhere (1h in-game cooldown applies).
  function requestReturn(uint32 tokenIndex) external nonReentrant {
    Listing storage l = _listings[tokenIndex];
    require(l.owner == msg.sender, NotOwner());
    require(l.renter == address(0), EndLeaseFirst());
    require(pendingRenter[tokenIndex] == address(0), PendingLeaseExists());
    require(l.staked, NotInMarket());
    require(!l.returning, AlreadyReturning());

    _creditPending(tokenIndex); // freeze attribution at request time
    l.returning = true;
    emit ReturnRequested(msg.sender, tokenIndex);
  }

  /// @notice finalize a send-back once the kami is verifiably in the OWNER's account.
  ///         callable by anyone; only clears if the kami actually went home.
  function clearReturned(uint32 tokenIndex) external nonReentrant {
    Listing memory l = _listings[tokenIndex];
    require(l.owner != address(0), NotListed());
    require(l.returning, NoReturnRequested());
    require(
      LibKami.getAccount(_comps(), l.kamiID) == IPersonalRentalCustody(l.owner).accID(),
      KamiNotHomeYet()
    );
    // carry any earnings accrued AFTER requestReturn's snapshot (e.g. a harvest
    // the automation hadn't stopped yet) before the listing is deleted, so the
    // final delta is attributed to the owner instead of being orphaned.
    _creditPending(tokenIndex);
    if (participations[l.owner] > 0) participations[l.owner]--;
    _removeListing(tokenIndex);
    emit ReturnCleared(l.owner, tokenIndex);
  }

  /// @notice After a normal lease, automation returns the idle Kami to its
  /// immutable Personal Rental Pool. Anyone may confirm, but only that exact
  /// on-chain destination can satisfy the check. The listing stays published
  /// and becomes rentable again without any owner transaction.
  function confirmReturnedToPool(uint32 tokenIndex) external {
    Listing storage l = _listings[tokenIndex];
    require(l.owner.code.length != 0, NotOwner());
    require(l.renter == address(0) && pendingRenter[tokenIndex] == address(0), Leased());
    require(LibKami.getAccount(_comps(), l.kamiID) == IPersonalRentalCustody(l.owner).accID(), KamiNotHomeYet());
    // Idempotent by design: this function is permissionless, so an unrelated
    // caller must not be able to front-run the factory and wedge the renter's
    // verified gas refund after the first successful confirmation.
    if (!l.staked) return;
    // Credit BEFORE re-baselining. _creditPending early-returns on !staked, so
    // advancing xpBase first would orphan the delta permanently — the swept
    // payItem would sit in the hub reachable by neither claimOwed (bounded by
    // owedMusu) nor claimMgmt (bounded by mgmtAccrued). Same reason clearReturned
    // credits first.
    _creditPending(tokenIndex);
    l.staked = false;
    l.xpBase = LibExperience.get(_comps(), l.kamiID);
    emit PoolRestored(l.owner, tokenIndex);
  }

  ///////////////////
  // RENTER SIDE

  /// @notice Reserve a personal-pool listing for a renter-funded RoomPod. The
  /// factory holds every wei and all setup metadata; this market stores only
  /// the two addresses needed to block conflicting owner/renter actions.
  function reserveProvisionedLease(
    address renter,
    uint32 tokenIndex,
    address pod,
    string calldata prefs,
    uint16 expectedOwnerShareBps,
    uint32 termSecs
  ) external nonReentrant {
    require(msg.sender == leaseFactory, NotFactory());
    Listing storage l = _listings[tokenIndex];
    require(l.owner != address(0), NotListed());
    require(l.owner.code.length != 0 && !l.staked, ProvisioningRequired());
    require(!l.returning, BeingReturned());
    require(l.renter == address(0), AlreadyLeased());
    require(pendingRenter[tokenIndex] == address(0), PendingLeaseExists());
    // l.owner is ALWAYS a PersonalRentalPool clone (listKami gates on
    // registry.isPool), never an EOA — comparing it to a renter EOA could never
    // be true, so this guard was dead. The human is the beneficiary, which is
    // the same identity _creditSplit pays.
    require(_listingBeneficiary[tokenIndex] != renter, OwnKami());
    require(l.reservedFor == address(0) || l.reservedFor == renter, Reserved());
    require(l.ownerShareBps == expectedOwnerShareBps, TermsChanged());
    require(termSecs >= MIN_TERM && termSecs <= l.maxTermSecs, TermRails());
    require(!LibKami.isState(_comps(), l.kamiID, "DEAD"), "LM: kami is dead");

    IRenterRoomPod roomPod = IRenterRoomPod(pod);
    require(address(roomPod.hub()) == address(this), NotFactory());
    require(roomPod.accID() != 0 && roomPod.payItem() == payItem, NotFactory());

    pendingRenter[tokenIndex] = renter;
    pendingPod[tokenIndex] = pod;
    emit LeaseProvisionRequested(
      renter,
      tokenIndex,
      pod,
      roomPod.nodeIndex(),
      0,
      termSecs,
      prefs
    );
  }

  /// @notice The factory calls this only after Kamibots has registered and
  /// parked the dedicated pod. It moves the Kami from its owner's idle pool to
  /// the shared hub, without starting the paid lease clock.
  function prepareProvisionedLease(uint32 tokenIndex) external nonReentrant {
    require(msg.sender == leaseFactory, NotFactory());
    Listing storage l = _listings[tokenIndex];
    require(pendingRenter[tokenIndex] != address(0), NoPendingLease());
    require(!l.staked, AlreadyInPool());
    IPersonalRentalCustody(l.owner).releaseToMarket(tokenIndex);
    require(LibKami.getAccount(_comps(), l.kamiID) == accID, NotArrived());
    l.staked = true;
    l.xpBase = LibExperience.get(_comps(), l.kamiID);
    emit Arrived(l.owner, tokenIndex);
    emit LeasePreparing(tokenIndex, pendingPod[tokenIndex]);
  }

  /// @notice Start the paid term only after the dedicated pod actually holds
  /// the Kami and Kamibots has accepted the renter's selected strategy.
  function activateProvisionedLease(
    uint32 tokenIndex,
    string calldata prefs,
    uint32 termSecs
  ) external nonReentrant {
    require(msg.sender == leaseFactory, NotFactory());
    Listing storage l = _listings[tokenIndex];
    address renter = pendingRenter[tokenIndex];
    address pod = pendingPod[tokenIndex];
    require(renter != address(0), NoPendingLease());
    require(l.staked, NotInPoolYet());
    require(termSecs >= MIN_TERM && termSecs <= l.maxTermSecs, TermRails());
    require(LibKami.getAccount(_comps(), l.kamiID) == IRenterRoomPod(pod).accID(), NotArrived());
    require(!LibKami.isState(_comps(), l.kamiID, "DEAD"), "LM: kami is dead");

    _creditPending(tokenIndex); // setup-time XP remains the owner's
    l.renter = renter;
    l.gasBudget = 0; // renter ETH remains in the dedicated factory escrow
    l.leaseStart = uint64(block.timestamp);
    l.leaseEnd = uint64(block.timestamp) + termSecs;
    participations[renter]++;
    delete pendingRenter[tokenIndex];
    delete pendingPod[tokenIndex];
    emit LeaseAccepted(renter, tokenIndex, 0, prefs);
  }

  /// @notice Clear a factory reservation. If custody was dispatched, the
  /// factory can clear it only after the Kami is provably back in its immutable
  /// owner's Personal Rental Pool.
  function cancelProvisionedLease(uint32 tokenIndex) external nonReentrant {
    require(msg.sender == leaseFactory, NotFactory());
    Listing storage l = _listings[tokenIndex];
    address renter = pendingRenter[tokenIndex];
    require(renter != address(0), NoPendingLease());
    if (l.staked) {
      require(
        LibKami.getAccount(_comps(), l.kamiID) == IPersonalRentalCustody(l.owner).accID(),
        KamiNotHomeYet()
      );
      // during PREPARING l.renter is still zero, so this delta is 100% the
      // owner's — credit it before the baseline moves (see confirmReturnedToPool)
      _creditPending(tokenIndex);
      l.staked = false;
      l.xpBase = LibExperience.get(_comps(), l.kamiID);
    }
    delete pendingRenter[tokenIndex];
    delete pendingPod[tokenIndex];
    emit PreparingLeaseCancelled(tokenIndex, renter);
  }

  /// @notice update strategy preferences (relayed off-chain to the automation)
  function setPrefs(uint32 tokenIndex, string calldata prefs) external {
    Listing storage l = _listings[tokenIndex];
    require(l.renter != address(0) && (msg.sender == l.renter || msg.sender == leaseFactory), NotRenter());
    require(!l.ending, EndingNow());
    emit PrefsUpdated(tokenIndex, l.renter, prefs);
  }

  /// @notice extend a running lease in place — no re-accept, no send cooldown.
  ///         The total term stays within the owner's maxTermSecs.
  function extendLease(uint32 tokenIndex, uint32 extraSecs) external {
    Listing storage l = _listings[tokenIndex];
    require(msg.sender == leaseFactory, NotFactory());
    require(l.renter != address(0), NotLeased());
    require(!l.ending, EndingNow());
    require(extraSecs != 0, TermRails());
    uint64 newEnd = l.leaseEnd + extraSecs;
    require(uint256(newEnd) - l.leaseStart <= l.maxTermSecs, TermRails());
    l.leaseEnd = newEnd;
    emit LeaseExtended(tokenIndex, newEnd);
  }

  /// @notice Request lease end. The renter may request it after the minimum term,
  ///         and after expiry anyone may request it. The owner cannot cancel a
  ///         renter's already-paid term early. Accounting
  ///         is finalized only after the keeper has stopped the active harvest and
  ///         swept its pod. This prevents the final harvest from being orphaned.
  function endLease(uint32 tokenIndex) external nonReentrant {
    Listing storage l = _listings[tokenIndex];
    address renter = l.renter;
    require(renter != address(0), NotLeased());
    require(!l.ending, AlreadyEnding());
    if (block.timestamp <= uint256(l.leaseEnd)) {
      require(msg.sender == renter, NotRenter());
      require(block.timestamp >= uint256(l.leaseStart) + MIN_TERM, MinTerm());
    } // past leaseEnd the lease is EXPIRED: anyone (the keeper) may flip it

    l.ending = true;
    endingAt[tokenIndex] = uint64(block.timestamp);
    emit LeaseEnding(tokenIndex, renter, msg.sender);
  }

  /// @notice Keeper-only finalization after strategy stop + pod sweep. Credits the
  ///         exact final XP delta at the lease split, then refunds unused gas.
  function finalizeLease(uint32 tokenIndex) external nonReentrant {
    Listing storage l = _listings[tokenIndex];
    address renter = l.renter;
    require(renter != address(0), NotLeased());
    require(l.ending, NotEnding());
    bool timedOut = block.timestamp >= uint256(endingAt[tokenIndex]) + ENDING_GRACE;
    require(
      msg.sender == settler || msg.sender == leaseFactory
        || (timedOut && (msg.sender == renter || msg.sender == l.owner)),
      NotFinalizer()
    );
    require(!LibKami.isState(_comps(), l.kamiID, "HARVESTING"), "LM: still harvesting");

    _creditPending(tokenIndex); // final split at the lease's terms

    l.renter = address(0);
    l.gasBudget = 0;
    l.ending = false;
    delete endingAt[tokenIndex];
    if (participations[renter] > 0) participations[renter]--;

    emit LeaseEnded(tokenIndex, renter, 0);
  }

  ///////////////////
  // SETTLEMENT

  /// @notice Compatibility entry point. One call accounts for at most
  /// MAX_SETTLE_BATCH listings; anyone may continue an open cycle.
  function settle() external nonReentrant {
    _settleBatch(MAX_SETTLE_BATCH);
  }

  /// @notice Bounded daily accounting. Starting a cycle preserves the existing
  /// settler/cooldown rules; continuation is permissionless so a crashed keeper
  /// cannot strand a partially-accounted market.
  function settleBatch(uint256 maxItems) external nonReentrant {
    if (maxItems == 0 || maxItems > MAX_SETTLE_BATCH) revert BadBatch();
    _settleBatch(maxItems);
  }

  function _settleBatch(uint256 maxItems) internal {
    require(accID != 0, NotInit());
    if (!settlementInProgress) {
      uint256 base = lastSettleAt == 0 ? initializedAt : lastSettleAt;
      require(msg.sender == settler || block.timestamp >= base + SETTLER_STALE, NotSettler());
      require(
        lastSettleAt == 0 || block.timestamp >= uint256(lastSettleAt) + settleCooldown,
        Cooldown()
      );
      settlementInProgress = true;
      settleCursor = 0;
      lastSettleAt = uint64(block.timestamp);
    }

    IUintComp comps = _comps();
    uint256 n = tokenIndices.length;
    uint256 start = settleCursor;
    uint256 end = start + maxItems;
    if (end > n) end = n;
    uint256 totalDelta;
    uint256 mgmtAdd;
    for (uint256 i = start; i < end; i++) {
      // hoisted into _settleOne: the split call's operands blow the legacy
      // codegen stack when inlined here (this repo builds tests without via-IR)
      (uint256 delta, uint256 cut) = _settleOne(comps, tokenIndices[i]);
      totalDelta += delta;
      mgmtAdd += cut;
    }
    mgmtAccrued += mgmtAdd;
    settleCursor = end;
    bool complete = end >= tokenIndices.length;
    if (complete) {
      settlementInProgress = false;
      settleCursor = 0;
    }
    emit Settled(totalDelta - mgmtAdd, mgmtAdd, totalDelta);
    emit SettlementBatch(start, end, complete);
  }

  /// @dev Credit one exact gross pool. User claims are senior to management:
  ///      they remain reserved in owedMusuTotal until the user pulls them.
  function _creditSplit(
    address owner_,
    address renter_,
    uint16 shareBps,
    uint256 gross
  ) internal returns (uint256 cut) {
    cut = (gross * mgmtBps) / 10000;
    uint256 net = gross - cut;
    if (renter_ == address(0)) {
      _credit(owner_, net);
    } else {
      uint256 ownerCut = (net * shareBps) / 10000;
      if (ownerCut > 0) _credit(owner_, ownerCut);
      if (net - ownerCut > 0) _credit(renter_, net - ownerCut);
    }
  }

  /// @notice claim held MUSU (payee had no game account, or amount was below the
  ///         transfer fee). the fee comes out of the claimed amount.
  function claimOwed() external nonReentrant {
    uint256 amount = owedMusu[msg.sender];
    require(amount > _claimFee(), NothingClaimable());
    uint256 target = uint256(uint160(msg.sender));
    require(_isAccount(target), RegisterAnAccountFirst());
    require(LibInventory.getBalanceOf(_comps(), accID, payItem) >= amount, "LM: not backed yet");
    owedMusu[msg.sender] = 0;
    owedMusuTotal -= amount; // release the reservation as the funds leave
    _transferMusu(target, amount - _claimFee());
    emit OwedClaimed(msg.sender, amount);
  }

  /// @notice Release a balance that is too small to ever be delivered.
  /// @dev The in-game transfer fee is a flat 15 MUSU, so a payee holding at or
  ///      below it can never claim: `claimOwed` reverts forever while
  ///      `owedMusuTotal` keeps the amount reserved, permanently shaving that
  ///      much off what management can withdraw. One abandoned payee is dust;
  ///      they accumulate, and nothing else can ever clear them.
  ///
  ///      Only the payee may do this, and only while the balance is genuinely
  ///      unreachable — so no admin gains any power over user funds, and a
  ///      balance that later grows past the fee stays claimable as normal.
  ///      Forfeited dust goes to management rather than being burned: it is
  ///      real backed inventory that would otherwise sit frozen forever.
  ///
  ///      A non-MUSU hub pays no transfer fee, so `_claimFee()` is 0 and this
  ///      is unreachable there by construction.
  function forfeitDust() external nonReentrant {
    uint256 amount = owedMusu[msg.sender];
    require(amount > 0 && amount <= _claimFee(), NotDust());
    owedMusu[msg.sender] = 0;
    owedMusuTotal -= amount; // release the reservation
    mgmtAccrued += amount;
    emit DustForfeited(msg.sender, amount);
  }

  /// @notice Withdraw accrued platform fees only from inventory above all user
  ///         claims. Pod sweep fees and any temporary shortfall therefore come
  ///         out of management, never from owners or renters.
  function claimMgmt() external nonReentrant {
    require(mgmtAccID != 0, MgmtAccountUnset());
    uint256 bal = LibInventory.getBalanceOf(_comps(), accID, payItem);
    uint256 surplus = bal > owedMusuTotal ? bal - owedMusuTotal : 0;
    uint256 amount = mgmtAccrued < surplus ? mgmtAccrued : surplus;
    require(amount > _claimFee(), NothingClaimable());
    mgmtAccrued -= amount;
    _transferMusu(mgmtAccID, amount - _claimFee());
  }

  /// @dev the in-game transfer fee is ALWAYS 15 MUSU. A MUSU market nets it out
  ///      of the payout; a non-MUSU market pays it from the hub's MUSU float, so
  ///      claimants receive their full item amount.
  function _claimFee() internal view returns (uint256) {
    return payItem == MUSU_INDEX ? TRANSFER_FEE : 0;
  }

  ///////////////////
  // VIEWS

  function numListings() external view returns (uint256) {
    return tokenIndices.length;
  }

  /// @dev explicit struct getter — the 14-field auto-getter blows the stack
  function listings(uint32 tokenIndex) external view returns (Listing memory) {
    return _listings[tokenIndex];
  }

  function leaseRenter(uint32 tokenIndex) external view returns (address) {
    return _listings[tokenIndex].renter;
  }

  /// @notice The economic owner shown by the marketplace. For a Personal
  /// Rental Pool this is the pool's immutable owner; for legacy listings it is
  /// the listing owner itself.
  function listingBeneficiary(uint32 tokenIndex) external view returns (address) {
    return _listingBeneficiary[tokenIndex];
  }

  /// @notice Immutable Personal Rental Pool destination for custody recovery.
  function listingPool(uint32 tokenIndex) external view returns (address) {
    return _listings[tokenIndex].owner;
  }

  function listingKamiID(uint32 tokenIndex) external view returns (uint256) {
    return _listings[tokenIndex].kamiID;
  }

  function listingKamiAccount(uint32 tokenIndex) external view returns (uint256) {
    return LibKami.getAccount(_comps(), _listings[tokenIndex].kamiID);
  }

  /// @notice True only after an ending lease has exceeded its immutable grace
  /// period. The renter factory uses this proof before destroying a live pod
  /// operator and entering destination-constrained recovery mode.
  function recoveryReady(uint32 tokenIndex) external view returns (bool) {
    Listing storage l = _listings[tokenIndex];
    return l.renter != address(0) && l.ending && endingAt[tokenIndex] != 0
      && block.timestamp >= uint256(endingAt[tokenIndex]) + ENDING_GRACE;
  }

  /// @notice the market account's CURRENT operator — the KamiSend destination.
  ///         the dApp resolves the send target from THIS on-chain (not a
  ///         hardcoded constant), so a redeploy can never leave a user sending
  ///         a kami to a stale account.
  function operatorAddr() external view returns (address) {
    return LibAccount.getOperator(_comps(), accID);
  }


  function pendingXpDelta(uint32 tokenIndex) public view returns (uint256) {
    Listing memory l = _listings[tokenIndex];
    if (!l.staked) return 0;
    uint256 xp = LibExperience.get(_comps(), l.kamiID);
    return xp > l.xpBase ? xp - l.xpBase : 0;
  }

  function musuBalance() external view returns (uint256) {
    return LibInventory.getBalanceOf(_comps(), accID, payItem);
  }

  /// @notice Difference between all recorded claims and current hub inventory.
  ///         User claims are still senior because claimMgmt can use only surplus.
  function backingShortfall() external view returns (uint256) {
    uint256 promised = owedMusuTotal + mgmtAccrued;
    uint256 bal = LibInventory.getBalanceOf(_comps(), accID, payItem);
    return promised > bal ? promised - bal : 0;
  }

  /// @notice has this kami arrived in the market's game account? (UI helper for the
  ///         send-in flow's confirm step)
  function kamiInMarket(uint32 tokenIndex) external view returns (bool) {
    uint256 kamiID = LibKami.getByIndex(_comps(), tokenIndex);
    return LibKami.getAccount(_comps(), kamiID) == accID;
  }

  ///////////////////
  // INTERNALS

  /// @dev One listing's share of a settle batch: advance its baseline and credit
  ///      the delta at the listing's current terms.
  function _settleOne(
    IUintComp comps,
    uint32 tokenIndex
  ) internal returns (uint256 delta, uint256 cut) {
    Listing storage l = _listings[tokenIndex];
    if (!l.staked) return (0, 0);
    uint256 xp = LibExperience.get(comps, l.kamiID);
    delta = xp > l.xpBase ? xp - l.xpBase : 0;
    l.xpBase = xp;
    if (delta == 0) return (0, 0);
    cut = _creditSplit(_listingBeneficiary[tokenIndex], _activeRenter(l), l.ownerShareBps, delta);
  }

  /// @dev The renter earns only within the term they paid for. l.renter is
  ///      cleared by finalizeLease, but nothing forces finalizeLease to be
  ///      prompt — and renters pay no rent, so every second past leaseEnd was
  ///      free yield taken from the owner. Attribution now follows the clock,
  ///      not the bookkeeping.
  function _activeRenter(Listing storage l) internal view returns (address) {
    if (l.renter == address(0)) return address(0);
    return block.timestamp > l.leaseEnd ? address(0) : l.renter;
  }

  /// @dev Credit a kami's current delta immediately at its current terms. Used at
  ///      lease/listing boundaries so attribution cannot race a later daily settle.
  function _creditPending(uint32 tokenIndex) internal {
    Listing storage l = _listings[tokenIndex];
    if (!l.staked) return;
    uint256 xp = LibExperience.get(_comps(), l.kamiID);
    uint256 delta = xp > l.xpBase ? xp - l.xpBase : 0;
    l.xpBase = xp;
    if (delta == 0) return;
    uint256 cut = _creditSplit(
      _listingBeneficiary[tokenIndex],
      _activeRenter(l),
      l.ownerShareBps,
      delta
    );
    mgmtAccrued += cut;
    emit Settled(delta - cut, cut, delta);
  }

  function _credit(address to, uint256 amount) internal {
    owedMusu[to] += amount;
    owedMusuTotal += amount;
    emit Payout(to, amount, true);
  }

  function _transferMusu(uint256 targetAccID, uint256 amount) internal {
    uint32[] memory indices = new uint32[](1);
    uint256[] memory amts = new uint256[](1);
    indices[0] = payItem;
    amts[0] = amount;
    ItemTransferSystem(_sys(ItemTransferSystemID)).executeTyped(indices, amts, targetAccID);
  }

  function _removeListing(uint32 tokenIndex) internal {
    uint256 pos = tokenPos[tokenIndex];
    uint256 last = tokenIndices.length;
    uint256 removedIndex = pos - 1;
    if (pos != last) {
      uint32 moved = tokenIndices[last - 1];
      tokenIndices[removedIndex] = moved;
      tokenPos[moved] = pos;
    }
    tokenIndices.pop();
    delete tokenPos[tokenIndex];
    delete pendingRenter[tokenIndex];
    delete pendingPod[tokenIndex];
    delete _listingBeneficiary[tokenIndex];
    delete _listings[tokenIndex];
    // A tail listing can be swapped into an already-processed slot. Rewind to
    // that slot; repeat visits are safe because settlement advances xpBase.
    if (settlementInProgress && removedIndex < settleCursor) settleCursor = removedIndex;
  }

  /// @dev the marketplace-readiness rule: RESTING and effectively at FULL HEALTH
  ///      (stored HP plus resting regeneration since the last sync).
  function _isRestedFull(uint256 kamiID) internal view returns (bool) {
    IUintComp comps = _comps();
    if (!LibKami.isState(comps, kamiID, "RESTING")) return false;
    Stat memory hp = LibStat.get(comps, "HEALTH", kamiID);
    int32 total = LibStat.getTotal(comps, "HEALTH", kamiID);
    if (hp.sync >= total) return true;
    uint256 recovered = LibKami.calcRecovery(comps, kamiID);
    return int256(hp.sync) + int256(recovered) >= int256(total);
  }

  function _isAccount(uint256 id) internal view returns (bool) {
    return LibEntityType.isShape(_comps(), id, "ACCOUNT");
  }

  function _sys(uint256 id) internal view returns (address) {
    return getAddrByID(world.systems(), id);
  }

  function _comps() internal view returns (IUintComp) {
    return world.components();
  }
}
