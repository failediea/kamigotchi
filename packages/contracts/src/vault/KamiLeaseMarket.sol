// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import { IWorld } from "solecs/interfaces/IWorld.sol";
import { IUint256Component as IUintComp } from "solecs/interfaces/IUint256Component.sol";
import { getAddrByID } from "solecs/utils.sol";

import { AccountRegisterSystem, ID as AccountRegisterSystemID } from "systems/AccountRegisterSystem.sol";
import { AccountSetOperatorSystem, ID as AccountSetOperatorSystemID } from "systems/AccountSetOperatorSystem.sol";
import { Kami721StakeSystem, ID as Kami721StakeSystemID } from "systems/Kami721StakeSystem.sol";
import { Kami721UnstakeSystem, ID as Kami721UnstakeSystemID } from "systems/Kami721UnstakeSystem.sol";
import { ItemTransferSystem, ID as ItemTransferSystemID } from "systems/ItemTransferSystem.sol";

import { LibAccount } from "libraries/LibAccount.sol";
import { LibExperience } from "libraries/LibExperience.sol";
import { LibInventory, MUSU_INDEX, TRANSFER_FEE } from "libraries/LibInventory.sol";
import { LibKami } from "libraries/LibKami.sol";
import { LibStat } from "libraries/LibStat.sol";
import { Stat } from "solecs/components/types/Stat.sol";
import { LibEntityType } from "libraries/utils/LibEntityType.sol";

import { Kami721 } from "tokens/Kami721.sol";

/**
 * @title KamiLeaseMarket
 * @notice Managed-only kami lease marketplace on Yominet.
 *
 * Model:
 *  - OWNERS list kamis: the ERC721 is custodied by this contract, staked into the
 *    market's own game account. Owners set their share of earnings (bps).
 *  - RENTERS accept a lease by funding a GAS BUDGET (ETH) that pays for the farming
 *    transactions, and may attach strategy preferences (relayed to the automation).
 *  - Farming is performed by the platform's automation (Kamibots) via the single
 *    account operator key. NO key is ever given to owners or renters — a renter
 *    cannot send, sacrifice, or sell a kami. Custody is contract-enforced.
 *  - settle() splits each kami's earnings (attributed by XP delta, which increments
 *    1:1 with collected harvest output) three ways:
 *        platform fee (mgmtBps, can only be lowered)
 *        -> remainder: owner share (listing's ownerShareBps) / renter share.
 *    Earnings of an unleased-but-farmed kami go fully to the owner (minus fee).
 *  - withdrawKami() returns the NFT ONLY to the recorded owner, and only when the
 *    kami is not under an active lease. The admin cannot redirect assets; ETH gas
 *    budgets can only flow to the account operator or back to their renter.
 *
 * Residual risks (documented): the automation provider holds the operator key
 * (rotateOperator() is the kill switch); a DEAD kami blocks withdrawal until revived.
 */
contract KamiLeaseMarket {
  ///////////////////
  // TYPES

  struct Listing {
    address owner; // lessor; only address that can ever receive the kami back
    uint256 kamiID; // ECS entity
    uint256 xpBase; // attribution baseline (reset on settle / lease boundaries)
    uint16 ownerShareBps; // owner's share of post-fee earnings while leased
    uint128 minGasWei; // minimum gas budget to accept the lease
    bool staked; // true = IN THE POOL (market account custody); false = send pending
    bool returning; // owner requested an in-game send-back (blocks new leases)
    bool ending; // a party requested lease end; keeper must stop/sweep/finalize
    address renter; // active renter (0 = waiting in the pool)
    uint256 gasBudget; // renter's remaining ETH for farming gas
  }

  /// @dev earnings attribution carried across lease/withdraw boundaries until settle
  struct CarryEntry {
    address owner;
    address renter; // 0 = owner-only split
    uint16 ownerShareBps;
    uint256 delta;
  }


  ///////////////////
  // STATE

  IWorld public immutable world;
  Kami721 public immutable kami721;
  address public admin;

  uint256 public accID; // the market's game account
  uint16 public mgmtBps; // platform fee, lower-only
  uint256 public mgmtAccID; // game account receiving the platform fee
  uint256 public mgmtAccrued; // platform fees accrued, awaiting transfer to mgmtAccID
  address public settler; // daily accounting + lease-finalization keeper

  mapping(uint32 => Listing) public listings; // by ERC721 token index
  uint32[] public tokenIndices;
  mapping(uint32 => uint256) internal tokenPos; // tokenIndex => position+1

  mapping(address => uint256) public owedMusu; // held payouts (no game account yet)
  uint256 public owedMusuTotal; // sum of owedMusu: RESERVED, never re-distributed
  mapping(address => uint256) public owedEth; // gas refunds that failed to send (pull)
  mapping(address => uint256) public participations; // active listings + leases per address
  mapping(uint32 => uint64) internal endingAt; // timeout clock for user recovery

  uint64 public lastSettleAt;
  uint64 public settleCooldown = 1 days; // daily accounting cadence; admin-tunable, capped
  uint64 internal initializedAt;

  uint64 internal constant ENDING_GRACE = 2 days;
  uint64 internal constant SETTLER_STALE = 3 days;

  uint256 private locked = 1;

  ///////////////////
  // EVENTS

  event Initialized(uint256 accID, address operator, string name);
  event OperatorRotated(address newOperator);
  event SettlerSet(address newSettler);
  event Listed(address indexed owner, uint32 indexed tokenIndex, uint16 ownerShareBps, uint128 minGasWei);
  event Delisted(address indexed owner, uint32 indexed tokenIndex);
  event Arrived(address indexed owner, uint32 indexed tokenIndex); // kami joined the pool
  event ReturnRequested(address indexed owner, uint32 indexed tokenIndex); // ops bot: KamiSend it home
  event ReturnCleared(address indexed owner, uint32 indexed tokenIndex);
  event EthOwed(address indexed to, uint256 amount);
  event EthClaimed(address indexed to, uint256 amount);
  event SettleCooldownSet(uint64 secs);
  event LeaseAccepted(address indexed renter, uint32 indexed tokenIndex, uint256 gasBudget, string prefs);
  event LeaseEnded(uint32 indexed tokenIndex, address indexed renter, uint256 gasRefund);
  event PrefsUpdated(uint32 indexed tokenIndex, address indexed renter, string prefs);
  event GasToppedUp(uint32 indexed tokenIndex, uint256 amount);
  event GasDripped(uint32 indexed tokenIndex, address operator, uint256 amount);
  event LeaseEnding(uint32 indexed tokenIndex, address indexed renter, address indexed requestedBy);
  event EndingGasReclaimed(uint32 indexed tokenIndex, address indexed renter, uint256 amount);
  event KamiWithdrawn(address indexed owner, uint32 indexed tokenIndex);
  event Settled(uint256 distributed, uint256 mgmtCut, uint256 totalDelta);
  event Payout(address indexed to, uint256 amount, bool held);
  event OwedClaimed(address indexed to, uint256 amount);
  event MgmtBpsLowered(uint16 newBps);

  ///////////////////
  // MODIFIERS

  modifier onlyAdmin() {
    require(msg.sender == admin, "LM: not admin");
    _;
  }

  modifier nonReentrant() {
    require(locked == 1, "LM: reentrancy");
    locked = 2;
    _;
    locked = 1;
  }

  ///////////////////
  // SETUP / ADMIN

  constructor(IWorld _world, Kami721 _kami721, uint16 _mgmtBps) {
    require(_mgmtBps <= 3000, "LM: fee > 30%");
    world = _world;
    kami721 = _kami721;
    admin = msg.sender;
    mgmtBps = _mgmtBps;
  }

  function initialize(address operator, string calldata name) external onlyAdmin {
    require(accID == 0, "LM: initialized");
    bytes memory result = AccountRegisterSystem(_sys(AccountRegisterSystemID)).executeTyped(
      operator,
      name
    );
    accID = abi.decode(result, (uint256));
    initializedAt = uint64(block.timestamp);
    emit Initialized(accID, operator, name);
  }

  /// @notice kill switch: cut the automation off instantly
  function rotateOperator(address newOperator) external onlyAdmin {
    AccountSetOperatorSystem(_sys(AccountSetOperatorSystemID)).executeTyped(newOperator);
    emit OperatorRotated(newOperator);
  }

  function setSettler(address newSettler) external onlyAdmin {
    require(newSettler != address(0), "LM: zero settler");
    settler = newSettler;
    emit SettlerSet(newSettler);
  }

  function lowerMgmtBps(uint16 newBps) external onlyAdmin {
    require(newBps < mgmtBps, "LM: can only lower");
    mgmtBps = newBps;
    emit MgmtBpsLowered(newBps);
  }

  function setMgmtAccount(uint256 _mgmtAccID) external onlyAdmin {
    require(_isAccount(_mgmtAccID), "LM: not an account");
    mgmtAccID = _mgmtAccID;
  }

  /// @notice settle spam guard, capped at 7 days so payouts can't be locked up
  function setSettleCooldown(uint64 secs) external onlyAdmin {
    require(secs <= 7 days, "LM: cooldown too long");
    settleCooldown = secs;
    emit SettleCooldownSet(secs);
  }

  /// @notice pull gas from a lease's budget to the operator wallet. admin-triggered,
  ///         but funds can ONLY go to the current account operator.
  function dripGas(uint32 tokenIndex, uint256 amount) external onlyAdmin {
    Listing storage l = listings[tokenIndex];
    require(l.renter != address(0), "LM: not leased");
    require(l.gasBudget >= amount, "LM: budget too low");
    l.gasBudget -= amount;
    address operator = LibAccount.getOperator(_comps(), accID);
    (bool ok, ) = operator.call{ value: amount }("");
    require(ok, "LM: drip failed");
    emit GasDripped(tokenIndex, operator, amount);
  }

  receive() external payable {}

  ///////////////////
  // OWNER SIDE (lessor) — listing SENDS the kami into the pool

  /// @notice STEP 1 of listing: declare terms. the kami must be RESTING at FULL
  ///         HEALTH and in YOUR account. STEP 2: KamiSend it to the market in-game.
  ///         Once it arrives (confirmArrival) it sits in the POOL — out of your
  ///         hands, unfarmed, waiting for a renter.
  function listKami(uint32 tokenIndex, uint16 ownerShareBps, uint128 minGasWei) external {
    require(accID != 0, "LM: not initialized");
    require(ownerShareBps <= 10000, "LM: share > 100%");
    require(listings[tokenIndex].owner == address(0), "LM: already listed");

    uint256 kamiID = LibKami.getByIndex(_comps(), tokenIndex);
    // the caller's game account IS uint160(caller) — verify current in-game ownership
    require(
      LibKami.getAccount(_comps(), kamiID) == uint256(uint160(msg.sender)),
      "LM: kami not in your account"
    );
    require(_isRestedFull(kamiID), "LM: must be resting at full health");

    listings[tokenIndex] = Listing({
      owner: msg.sender,
      kamiID: kamiID,
      xpBase: 0,
      ownerShareBps: ownerShareBps,
      minGasWei: minGasWei,
      staked: false, // becomes true when the kami arrives in the pool
      returning: false,
      ending: false,
      renter: address(0),
      gasBudget: 0
    });
    tokenIndices.push(tokenIndex);
    tokenPos[tokenIndex] = tokenIndices.length;
    participations[msg.sender]++;

    emit Listed(msg.sender, tokenIndex, ownerShareBps, minGasWei);
  }

  /// @notice ONE-TX LISTING for a kami held as an NFT in your wallet: approve
  ///         (or setApprovalForAll once), then this pulls the token and stakes
  ///         it STRAIGHT INTO THE POOL — the market account lives in the bridge
  ///         room, so the kami is pooled and rentable in this same transaction.
  ///         No send, no operator, no waiting. It rests (and heals) unfarmed
  ///         until rented; withdrawKami returns it as an NFT, so every future
  ///         listing of this kami is one click too.
  function listKami721(uint32 tokenIndex, uint16 ownerShareBps, uint128 minGasWei)
    external
    nonReentrant
  {
    require(accID != 0, "LM: not initialized");
    require(ownerShareBps <= 10000, "LM: share > 100%");
    require(listings[tokenIndex].owner == address(0), "LM: already listed");

    kami721.transferFrom(msg.sender, address(this), uint256(tokenIndex));
    Kami721StakeSystem(_sys(Kami721StakeSystemID)).executeTyped(tokenIndex);

    uint256 kamiID = LibKami.getByIndex(_comps(), tokenIndex);
    // same admission rule as the legacy path: a renter must never receive a
    // wounded kami. staking marks it RESTING; require effective full health too.
    require(_isRestedFull(kamiID), "LM: must be resting at full health");
    listings[tokenIndex] = Listing({
      owner: msg.sender,
      kamiID: kamiID,
      xpBase: LibExperience.get(_comps(), kamiID),
      ownerShareBps: ownerShareBps,
      minGasWei: minGasWei,
      staked: true, // in the pool from this very transaction
      returning: false,
      ending: false,
      renter: address(0),
      gasBudget: 0
    });
    tokenIndices.push(tokenIndex);
    tokenPos[tokenIndex] = tokenIndices.length;
    participations[msg.sender]++;

    emit Listed(msg.sender, tokenIndex, ownerShareBps, minGasWei);
    emit Arrived(msg.sender, tokenIndex);
  }

  /// @notice STEP 3: confirm the kami arrived in the pool (anyone/keeper). only now
  ///         is it rentable. it sits UNFARMED until someone rents it.
  function confirmArrival(uint32 tokenIndex) external nonReentrant {
    Listing storage l = listings[tokenIndex];
    require(l.owner != address(0), "LM: not listed");
    require(!l.staked, "LM: already in pool");
    require(LibKami.getAccount(_comps(), l.kamiID) == accID, "LM: not arrived");

    l.staked = true;
    l.xpBase = LibExperience.get(_comps(), l.kamiID);
    emit Arrived(l.owner, tokenIndex);
  }

  /// @notice cancel a listing whose kami was never sent (nothing to return)
  function delist(uint32 tokenIndex) external {
    Listing memory l = listings[tokenIndex];
    require(l.owner == msg.sender, "LM: not owner");
    require(l.renter == address(0), "LM: leased");
    require(!l.staked, "LM: in pool - use requestReturn");
    if (participations[l.owner] > 0) participations[l.owner]--;
    _removeListing(tokenIndex);
    emit Delisted(msg.sender, tokenIndex);
  }

  /// @notice update lease terms. only while not leased.
  function updateTerms(uint32 tokenIndex, uint16 ownerShareBps, uint128 minGasWei) external {
    Listing storage l = listings[tokenIndex];
    require(l.owner == msg.sender, "LM: not owner");
    require(l.renter == address(0), "LM: leased");
    require(!l.returning, "LM: being returned");
    require(ownerShareBps <= 10000, "LM: share > 100%");
    l.ownerShareBps = ownerShareBps;
    l.minGasWei = minGasWei;
    emit Listed(msg.sender, tokenIndex, ownerShareBps, minGasWei);
  }

  /// @notice withdraw a kami. only the owner, only when not leased; NFT goes only to
  ///         the recorded owner. un-settled earnings are carried to the next settle.
  function withdrawKami(uint32 tokenIndex) external nonReentrant {
    Listing memory l = listings[tokenIndex];
    require(l.owner == msg.sender, "LM: not owner");
    require(l.renter == address(0), "LM: end lease first");
    require(l.staked, "LM: not in pool - use delist");

    _creditPending(tokenIndex);
    Kami721UnstakeSystem(_sys(Kami721UnstakeSystemID)).executeTyped(tokenIndex);
    if (participations[l.owner] > 0) participations[l.owner]--;
    _removeListing(tokenIndex);
    kami721.transferFrom(address(this), l.owner, uint256(tokenIndex));
    emit KamiWithdrawn(l.owner, tokenIndex);
  }

  /// @notice PREFERRED exit: request an in-game send-back. Snapshots earnings, blocks
  ///         new leases, and signals the automation to KamiSend the kami home — no
  ///         bridge room, works from anywhere (1h in-game cooldown applies).
  function requestReturn(uint32 tokenIndex) external nonReentrant {
    Listing storage l = listings[tokenIndex];
    require(l.owner == msg.sender, "LM: not owner");
    require(l.renter == address(0), "LM: end lease first");
    require(l.staked, "LM: not in market");
    require(!l.returning, "LM: already returning");

    _creditPending(tokenIndex); // freeze attribution at request time
    l.returning = true;
    emit ReturnRequested(msg.sender, tokenIndex);
  }

  /// @notice changed your mind (or the automation is down): re-open the listing.
  ///         ONLY valid while the kami is still in the pool — if the automation
  ///         already sent it home, the listing must be cleared (clearReturned),
  ///         never re-opened as rentable while the owner controls the kami
  ///         (that would be a phantom lease over an asset that isn't in custody).
  function cancelReturn(uint32 tokenIndex) external {
    Listing storage l = listings[tokenIndex];
    require(l.owner == msg.sender, "LM: not owner");
    require(l.returning, "LM: not returning");
    require(
      LibKami.getAccount(_comps(), l.kamiID) == accID,
      "LM: already sent home - use clearReturned"
    );
    l.returning = false;
    emit Listed(l.owner, tokenIndex, l.ownerShareBps, l.minGasWei);
  }

  /// @notice finalize a send-back once the kami is verifiably in the OWNER's account.
  ///         callable by anyone; only clears if the kami actually went home.
  function clearReturned(uint32 tokenIndex) external nonReentrant {
    Listing memory l = listings[tokenIndex];
    require(l.owner != address(0), "LM: not listed");
    require(l.returning, "LM: no return requested");
    require(
      LibKami.getAccount(_comps(), l.kamiID) == uint256(uint160(l.owner)),
      "LM: kami not home yet"
    );
    // carry any earnings accrued AFTER requestReturn's snapshot (e.g. a harvest
    // the automation hadn't stopped yet) before the listing is deleted, so the
    // final delta is attributed to the owner instead of being orphaned.
    _creditPending(tokenIndex);
    if (participations[l.owner] > 0) participations[l.owner]--;
    _removeListing(tokenIndex);
    emit ReturnCleared(l.owner, tokenIndex);
  }

  ///////////////////
  // RENTER SIDE

  /// @notice accept a lease: fund the gas budget (msg.value) and set strategy prefs.
  ///         attribution baseline resets so pre-lease earnings stay with the owner.
  /// @param expectedOwnerShareBps the terms the renter agreed to — reverts if the
  ///        listing's terms changed since they read them (frontrun guard)
  /// @notice rent a pooled kami — INSTANT, it's already here. the renter assumes
  ///         control: `prefs` carries THEIR choice of node (tile) and harvesting
  ///         strategy, which the automation executes for the lease's duration.
  function acceptLease(
    uint32 tokenIndex,
    string calldata prefs,
    uint16 expectedOwnerShareBps
  ) external payable nonReentrant {
    Listing storage l = listings[tokenIndex];
    require(l.owner != address(0), "LM: not listed");
    require(l.staked, "LM: not in pool yet");
    require(!l.returning, "LM: being returned");
    require(l.renter == address(0), "LM: already leased");
    require(l.owner != msg.sender, "LM: own kami");
    require(l.ownerShareBps == expectedOwnerShareBps, "LM: terms changed");
    require(msg.value >= l.minGasWei, "LM: gas budget too low");
    require(!LibKami.isState(_comps(), l.kamiID, "DEAD"), "LM: kami is dead");

    _creditPending(tokenIndex); // any pre-lease earnings stay with the owner

    l.renter = msg.sender;
    l.gasBudget = msg.value;
    participations[msg.sender]++;
    emit LeaseAccepted(msg.sender, tokenIndex, msg.value, prefs);
  }

  /// @notice update strategy preferences (relayed off-chain to the automation)
  function setPrefs(uint32 tokenIndex, string calldata prefs) external {
    Listing storage l = listings[tokenIndex];
    require(l.renter == msg.sender, "LM: not renter");
    require(!l.ending, "LM: lease ending");
    emit PrefsUpdated(tokenIndex, msg.sender, prefs);
  }

  function topUpGas(uint32 tokenIndex) external payable {
    Listing storage l = listings[tokenIndex];
    require(l.renter == msg.sender, "LM: not renter");
    require(!l.ending, "LM: lease ending");
    l.gasBudget += msg.value;
    emit GasToppedUp(tokenIndex, msg.value);
  }

  /// @notice Request lease end. The renter or owner may request it, but accounting
  ///         is finalized only after the keeper has stopped the active harvest and
  ///         swept its pod. This prevents the final harvest from being orphaned.
  function endLease(uint32 tokenIndex) external nonReentrant {
    Listing storage l = listings[tokenIndex];
    address renter = l.renter;
    require(renter != address(0), "LM: not leased");
    require(msg.sender == renter || msg.sender == l.owner, "LM: not party");
    require(!l.ending, "LM: already ending");

    l.ending = true;
    endingAt[tokenIndex] = uint64(block.timestamp);
    emit LeaseEnding(tokenIndex, renter, msg.sender);
  }

  /// @notice Keeper-only finalization after strategy stop + pod sweep. Credits the
  ///         exact final XP delta at the lease split, then refunds unused gas.
  function finalizeLease(uint32 tokenIndex) external nonReentrant {
    Listing storage l = listings[tokenIndex];
    address renter = l.renter;
    require(renter != address(0), "LM: not leased");
    require(l.ending, "LM: not ending");
    bool timedOut = block.timestamp >= uint256(endingAt[tokenIndex]) + ENDING_GRACE;
    require(
      msg.sender == settler || (timedOut && (msg.sender == renter || msg.sender == l.owner)),
      "LM: not finalizer"
    );
    require(!LibKami.isState(_comps(), l.kamiID, "HARVESTING"), "LM: still harvesting");

    _creditPending(tokenIndex); // final split at the lease's terms

    uint256 refund = l.gasBudget;
    l.renter = address(0);
    l.gasBudget = 0;
    l.ending = false;
    delete endingAt[tokenIndex];
    if (participations[renter] > 0) participations[renter]--;

    // pull-pattern fallback: a renter contract that reverts on receive must not be
    // able to block lease termination
    if (refund > 0) _sendEthOrOwe(renter, refund);
    emit LeaseEnded(tokenIndex, renter, refund);
  }

  /// @notice If automation cannot finish an ending lease, the renter can recover
  ///         the still-unused gas budget after the grace period even while the
  ///         kami remains harvesting. Final accounting can complete later.
  function reclaimEndingGas(uint32 tokenIndex) external nonReentrant {
    Listing storage l = listings[tokenIndex];
    require(l.renter == msg.sender, "LM: not renter");
    require(l.ending && block.timestamp >= uint256(endingAt[tokenIndex]) + ENDING_GRACE, "LM: grace");
    uint256 refund = l.gasBudget;
    require(refund > 0, "LM: no gas");
    l.gasBudget = 0;
    _sendEthOrOwe(msg.sender, refund);
    emit EndingGasReclaimed(tokenIndex, msg.sender, refund);
  }

  /// @notice claim ETH refunds that could not be pushed
  function claimEth() external nonReentrant {
    uint256 amount = owedEth[msg.sender];
    require(amount > 0, "LM: nothing owed");
    owedEth[msg.sender] = 0;
    (bool ok, ) = msg.sender.call{ value: amount }("");
    require(ok, "LM: claim failed");
    emit EthClaimed(msg.sender, amount);
  }

  ///////////////////
  // SETTLEMENT

  /// @notice Daily keeper accounting. XP deltas are converted into exact claims;
  ///         no transfers happen here, so one settlement cannot burn several
  ///         transfer fees or fail because a recipient has not registered yet.
  function settle() external nonReentrant {
    require(accID != 0, "LM: not initialized");
    uint256 base = lastSettleAt == 0 ? initializedAt : lastSettleAt;
    require(msg.sender == settler || block.timestamp >= base + SETTLER_STALE, "LM: not settler");
    require(
      lastSettleAt == 0 || block.timestamp >= uint256(lastSettleAt) + settleCooldown,
      "LM: cooldown"
    );
    IUintComp comps = _comps();
    uint256 n = tokenIndices.length;
    CarryEntry[] memory entries = new CarryEntry[](n);
    uint256 count;
    uint256 totalDelta;

    for (uint256 i; i < n; i++) {
      Listing storage l = listings[tokenIndices[i]];
      if (!l.staked) continue;
      uint256 xp = LibExperience.get(comps, l.kamiID);
      uint256 delta = xp > l.xpBase ? xp - l.xpBase : 0;
      l.xpBase = xp;
      if (delta == 0) continue;
      entries[count++] = CarryEntry(l.owner, l.renter, l.ownerShareBps, delta);
      totalDelta += delta;
    }
    uint256 mgmtAdd;
    for (uint256 i; i < count; i++) mgmtAdd += _creditEntry(entries[i], entries[i].delta);
    mgmtAccrued += mgmtAdd;
    lastSettleAt = uint64(block.timestamp);
    emit Settled(totalDelta - mgmtAdd, mgmtAdd, totalDelta);
  }

  /// @dev Credit one exact gross pool. User claims are senior to management:
  ///      they remain reserved in owedMusuTotal until the user pulls them.
  function _creditEntry(CarryEntry memory e, uint256 gross) internal returns (uint256 cut) {
    cut = (gross * mgmtBps) / 10000;
    uint256 net = gross - cut;
    if (e.renter == address(0)) {
      _credit(e.owner, net);
    } else {
      uint256 ownerCut = (net * e.ownerShareBps) / 10000;
      if (ownerCut > 0) _credit(e.owner, ownerCut);
      if (net - ownerCut > 0) _credit(e.renter, net - ownerCut);
    }
  }

  /// @notice claim held MUSU (payee had no game account, or amount was below the
  ///         transfer fee). the fee comes out of the claimed amount.
  function claimOwed() external nonReentrant {
    uint256 amount = owedMusu[msg.sender];
    require(amount > TRANSFER_FEE, "LM: nothing claimable");
    uint256 target = uint256(uint160(msg.sender));
    require(_isAccount(target), "LM: register an account first");
    require(LibInventory.getBalanceOf(_comps(), accID, MUSU_INDEX) >= amount, "LM: not backed yet");
    owedMusu[msg.sender] = 0;
    owedMusuTotal -= amount; // release the reservation as the funds leave
    _transferMusu(target, amount - TRANSFER_FEE);
    emit OwedClaimed(msg.sender, amount);
  }

  /// @notice Withdraw accrued platform fees only from inventory above all user
  ///         claims. Pod sweep fees and any temporary shortfall therefore come
  ///         out of management, never from owners or renters.
  function claimMgmt() external onlyAdmin nonReentrant {
    require(mgmtAccID != 0, "LM: mgmt account unset");
    uint256 bal = LibInventory.getBalanceOf(_comps(), accID, MUSU_INDEX);
    uint256 surplus = bal > owedMusuTotal ? bal - owedMusuTotal : 0;
    uint256 amount = mgmtAccrued < surplus ? mgmtAccrued : surplus;
    require(amount > TRANSFER_FEE, "LM: nothing claimable");
    mgmtAccrued -= amount;
    _transferMusu(mgmtAccID, amount - TRANSFER_FEE);
  }

  ///////////////////
  // VIEWS

  function numListings() external view returns (uint256) {
    return tokenIndices.length;
  }

  /// @notice the market account's CURRENT operator — the KamiSend destination.
  ///         the dApp resolves the send target from THIS on-chain (not a
  ///         hardcoded constant), so a redeploy can never leave a user sending
  ///         a kami to a stale account.
  function operatorAddr() external view returns (address) {
    return LibAccount.getOperator(_comps(), accID);
  }

  function pendingXpDelta(uint32 tokenIndex) public view returns (uint256) {
    Listing memory l = listings[tokenIndex];
    if (!l.staked) return 0;
    uint256 xp = LibExperience.get(_comps(), l.kamiID);
    return xp > l.xpBase ? xp - l.xpBase : 0;
  }

  function musuBalance() external view returns (uint256) {
    return LibInventory.getBalanceOf(_comps(), accID, MUSU_INDEX);
  }

  /// @notice Difference between all recorded claims and current hub inventory.
  ///         User claims are still senior because claimMgmt can use only surplus.
  function backingShortfall() external view returns (uint256) {
    uint256 promised = owedMusuTotal + mgmtAccrued;
    uint256 bal = LibInventory.getBalanceOf(_comps(), accID, MUSU_INDEX);
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

  /// @dev Credit a kami's current delta immediately at its current terms. Used at
  ///      lease/listing boundaries so attribution cannot race a later daily settle.
  function _creditPending(uint32 tokenIndex) internal {
    Listing storage l = listings[tokenIndex];
    if (!l.staked) return;
    uint256 xp = LibExperience.get(_comps(), l.kamiID);
    uint256 delta = xp > l.xpBase ? xp - l.xpBase : 0;
    l.xpBase = xp;
    if (delta == 0) return;
    uint256 cut = _creditEntry(CarryEntry(l.owner, l.renter, l.ownerShareBps, delta), delta);
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
    indices[0] = MUSU_INDEX;
    amts[0] = amount;
    ItemTransferSystem(_sys(ItemTransferSystemID)).executeTyped(indices, amts, targetAccID);
  }

  /// @dev push ETH; on failure record it as claimable instead of reverting
  function _sendEthOrOwe(address to, uint256 amount) internal {
    (bool ok, ) = to.call{ value: amount, gas: 50_000 }("");
    if (!ok) {
      owedEth[to] += amount;
      emit EthOwed(to, amount);
    }
  }

  function _removeListing(uint32 tokenIndex) internal {
    uint256 pos = tokenPos[tokenIndex];
    uint256 last = tokenIndices.length;
    if (pos != last) {
      uint32 moved = tokenIndices[last - 1];
      tokenIndices[pos - 1] = moved;
      tokenPos[moved] = pos;
    }
    tokenIndices.pop();
    delete tokenPos[tokenIndex];
    delete listings[tokenIndex];
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
