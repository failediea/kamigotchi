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
    address owner; // lessor; only address that can ever receive the NFT back
    uint256 kamiID; // ECS entity
    uint256 xpBase; // attribution baseline (reset on settle / lease boundaries)
    uint16 ownerShareBps; // owner's share of post-fee earnings while leased
    uint128 minGasWei; // minimum gas budget to accept the lease
    bool staked; // staked into the market's game account
    address renter; // active renter (0 = not leased)
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
  uint256 public reserveMusu; // MUSU held back at settle (ops: food, transfer fees)
  uint256 public mgmtAccID; // game account receiving the platform fee

  mapping(uint32 => Listing) public listings; // by ERC721 token index
  uint32[] public tokenIndices;
  mapping(uint32 => uint256) internal tokenPos; // tokenIndex => position+1

  CarryEntry[] public carries;
  mapping(address => uint256) public owedMusu; // held payouts (no game account yet)

  uint256 private locked = 1;

  ///////////////////
  // EVENTS

  event Initialized(uint256 accID, address operator, string name);
  event OperatorRotated(address newOperator);
  event Listed(address indexed owner, uint32 indexed tokenIndex, uint16 ownerShareBps, uint128 minGasWei);
  event Staked(uint32 indexed tokenIndex);
  event LeaseAccepted(address indexed renter, uint32 indexed tokenIndex, uint256 gasBudget, string prefs);
  event LeaseEnded(uint32 indexed tokenIndex, address indexed renter, uint256 gasRefund);
  event PrefsUpdated(uint32 indexed tokenIndex, address indexed renter, string prefs);
  event GasToppedUp(uint32 indexed tokenIndex, uint256 amount);
  event GasDripped(uint32 indexed tokenIndex, address operator, uint256 amount);
  event KamiWithdrawn(address indexed owner, uint32 indexed tokenIndex);
  event Settled(uint256 distributed, uint256 mgmtCut, uint256 totalDelta);
  event Payout(address indexed to, uint256 amount, bool held);
  event OwedClaimed(address indexed to, uint256 amount);
  event MgmtBpsLowered(uint16 newBps);

  ///////////////////
  // MODIFIERS

  modifier onlyAdmin() {
    require(msg.sender == admin, "LeaseMkt: not admin");
    _;
  }

  modifier nonReentrant() {
    require(locked == 1, "LeaseMkt: reentrancy");
    locked = 2;
    _;
    locked = 1;
  }

  ///////////////////
  // SETUP / ADMIN

  constructor(IWorld _world, Kami721 _kami721, uint16 _mgmtBps) {
    require(_mgmtBps <= 3000, "LeaseMkt: fee > 30%");
    world = _world;
    kami721 = _kami721;
    admin = msg.sender;
    mgmtBps = _mgmtBps;
  }

  function initialize(address operator, string calldata name) external onlyAdmin {
    require(accID == 0, "LeaseMkt: initialized");
    bytes memory result = AccountRegisterSystem(_sys(AccountRegisterSystemID)).executeTyped(
      operator,
      name
    );
    accID = abi.decode(result, (uint256));
    emit Initialized(accID, operator, name);
  }

  /// @notice kill switch: cut the automation off instantly
  function rotateOperator(address newOperator) external onlyAdmin {
    AccountSetOperatorSystem(_sys(AccountSetOperatorSystemID)).executeTyped(newOperator);
    emit OperatorRotated(newOperator);
  }

  function lowerMgmtBps(uint16 newBps) external onlyAdmin {
    require(newBps < mgmtBps, "LeaseMkt: can only lower");
    mgmtBps = newBps;
    emit MgmtBpsLowered(newBps);
  }

  function setMgmtAccount(uint256 _mgmtAccID) external onlyAdmin {
    require(_isAccount(_mgmtAccID), "LeaseMkt: not an account");
    mgmtAccID = _mgmtAccID;
  }

  function setReserve(uint256 _reserveMusu) external onlyAdmin {
    reserveMusu = _reserveMusu;
  }

  /// @notice pull gas from a lease's budget to the operator wallet. admin-triggered,
  ///         but funds can ONLY go to the current account operator.
  function dripGas(uint32 tokenIndex, uint256 amount) external onlyAdmin {
    Listing storage l = listings[tokenIndex];
    require(l.renter != address(0), "LeaseMkt: not leased");
    require(l.gasBudget >= amount, "LeaseMkt: budget too low");
    l.gasBudget -= amount;
    address operator = LibAccount.getOperator(_comps(), accID);
    (bool ok, ) = operator.call{ value: amount }("");
    require(ok, "LeaseMkt: drip failed");
    emit GasDripped(tokenIndex, operator, amount);
  }

  receive() external payable {}

  ///////////////////
  // OWNER SIDE (lessor)

  /// @notice list a kami for lease. pulls the ERC721 (requires prior approval).
  function listKami(uint32 tokenIndex, uint16 ownerShareBps, uint128 minGasWei) external nonReentrant {
    require(accID != 0, "LeaseMkt: not initialized");
    require(ownerShareBps <= 10000, "LeaseMkt: share > 100%");
    require(listings[tokenIndex].owner == address(0), "LeaseMkt: already listed");

    kami721.transferFrom(msg.sender, address(this), uint256(tokenIndex));

    listings[tokenIndex] = Listing({
      owner: msg.sender,
      kamiID: LibKami.getByIndex(_comps(), tokenIndex),
      xpBase: 0,
      ownerShareBps: ownerShareBps,
      minGasWei: minGasWei,
      staked: false,
      renter: address(0),
      gasBudget: 0
    });
    tokenIndices.push(tokenIndex);
    tokenPos[tokenIndex] = tokenIndices.length;

    emit Listed(msg.sender, tokenIndex, ownerShareBps, minGasWei);
  }

  /// @notice update lease terms. only while not leased.
  function updateTerms(uint32 tokenIndex, uint16 ownerShareBps, uint128 minGasWei) external {
    Listing storage l = listings[tokenIndex];
    require(l.owner == msg.sender, "LeaseMkt: not owner");
    require(l.renter == address(0), "LeaseMkt: leased");
    require(ownerShareBps <= 10000, "LeaseMkt: share > 100%");
    l.ownerShareBps = ownerShareBps;
    l.minGasWei = minGasWei;
    emit Listed(msg.sender, tokenIndex, ownerShareBps, minGasWei);
  }

  /// @notice stake listed kamis into the market's game account (keeper; bridge room)
  function stakeListings(uint32[] calldata idxs) external nonReentrant {
    Kami721StakeSystem staker = Kami721StakeSystem(_sys(Kami721StakeSystemID));
    for (uint256 i; i < idxs.length; i++) {
      Listing storage l = listings[idxs[i]];
      require(l.owner != address(0), "LeaseMkt: unknown listing");
      require(!l.staked, "LeaseMkt: already staked");
      staker.executeTyped(idxs[i]);
      l.staked = true;
      l.xpBase = LibExperience.get(_comps(), l.kamiID);
      emit Staked(idxs[i]);
    }
  }

  /// @notice withdraw a kami. only the owner, only when not leased; NFT goes only to
  ///         the recorded owner. un-settled earnings are carried to the next settle.
  function withdrawKami(uint32 tokenIndex) external nonReentrant {
    Listing memory l = listings[tokenIndex];
    require(l.owner == msg.sender, "LeaseMkt: not owner");
    require(l.renter == address(0), "LeaseMkt: end lease first");

    if (l.staked) {
      _carryPending(tokenIndex);
      Kami721UnstakeSystem(_sys(Kami721UnstakeSystemID)).executeTyped(tokenIndex);
    }
    _removeListing(tokenIndex);
    kami721.transferFrom(address(this), l.owner, uint256(tokenIndex));
    emit KamiWithdrawn(l.owner, tokenIndex);
  }

  ///////////////////
  // RENTER SIDE

  /// @notice accept a lease: fund the gas budget (msg.value) and set strategy prefs.
  ///         attribution baseline resets so pre-lease earnings stay with the owner.
  function acceptLease(uint32 tokenIndex, string calldata prefs) external payable nonReentrant {
    Listing storage l = listings[tokenIndex];
    require(l.owner != address(0), "LeaseMkt: not listed");
    require(l.staked, "LeaseMkt: not staked yet");
    require(l.renter == address(0), "LeaseMkt: already leased");
    require(l.owner != msg.sender, "LeaseMkt: own kami");
    require(msg.value >= l.minGasWei, "LeaseMkt: gas budget too low");

    _carryPending(tokenIndex); // owner keeps everything earned before this lease

    l.renter = msg.sender;
    l.gasBudget = msg.value;
    emit LeaseAccepted(msg.sender, tokenIndex, msg.value, prefs);
  }

  /// @notice update strategy preferences (relayed off-chain to the automation)
  function setPrefs(uint32 tokenIndex, string calldata prefs) external {
    require(listings[tokenIndex].renter == msg.sender, "LeaseMkt: not renter");
    emit PrefsUpdated(tokenIndex, msg.sender, prefs);
  }

  function topUpGas(uint32 tokenIndex) external payable {
    Listing storage l = listings[tokenIndex];
    require(l.renter == msg.sender, "LeaseMkt: not renter");
    l.gasBudget += msg.value;
    emit GasToppedUp(tokenIndex, msg.value);
  }

  /// @notice end a lease: renter or owner can end. pending earnings are carried at
  ///         the lease's split; the unused gas budget refunds to the renter.
  function endLease(uint32 tokenIndex) external nonReentrant {
    Listing storage l = listings[tokenIndex];
    address renter = l.renter;
    require(renter != address(0), "LeaseMkt: not leased");
    require(msg.sender == renter || msg.sender == l.owner, "LeaseMkt: not party");

    _carryPending(tokenIndex); // split at lease terms

    uint256 refund = l.gasBudget;
    l.renter = address(0);
    l.gasBudget = 0;

    if (refund > 0) {
      (bool ok, ) = renter.call{ value: refund }("");
      require(ok, "LeaseMkt: refund failed");
    }
    emit LeaseEnded(tokenIndex, renter, refund);
  }

  ///////////////////
  // SETTLEMENT

  /// @notice split accrued MUSU per-kami (XP delta), three ways. callable by anyone.
  function settle() external nonReentrant {
    require(accID != 0, "LeaseMkt: not initialized");
    IUintComp comps = _comps();

    uint256 bal = LibInventory.getBalanceOf(comps, accID, MUSU_INDEX);
    uint256 n = tokenIndices.length;
    uint256 m = carries.length;
    // worst case: 2 payees per kami + 2 per carry + platform fee transfer
    uint256 feeBudget = (2 * (n + m) + 1) * TRANSFER_FEE;
    if (bal <= reserveMusu + feeBudget) return;
    uint256 distributable = bal - reserveMusu - feeBudget;

    // ---- pass 1: gather attribution entries
    CarryEntry[] memory entries = new CarryEntry[](n + m);
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
    for (uint256 i; i < m; i++) {
      entries[count++] = carries[i];
      totalDelta += carries[i].delta;
    }
    delete carries;

    if (totalDelta == 0) return;

    // ---- pass 2: split + transfer
    uint256 mgmtCut = (distributable * mgmtBps) / 10000;
    uint256 pool = distributable - mgmtCut;
    uint256 paidOut;

    for (uint256 i; i < count; i++) {
      CarryEntry memory e = entries[i];
      uint256 earned = (pool * e.delta) / totalDelta;
      if (earned == 0) continue;

      if (e.renter == address(0)) {
        paidOut += _payout(e.owner, earned); // unleased: owner keeps it all
      } else {
        uint256 ownerCut = (earned * e.ownerShareBps) / 10000;
        if (ownerCut > 0) paidOut += _payout(e.owner, ownerCut);
        if (earned - ownerCut > 0) paidOut += _payout(e.renter, earned - ownerCut);
      }
    }

    if (mgmtCut > 0 && mgmtAccID != 0) _transferMusu(mgmtAccID, mgmtCut);

    emit Settled(paidOut, mgmtCut, totalDelta);
  }

  /// @notice claim MUSU held because the payee had no game account at settle time
  function claimOwed() external nonReentrant {
    uint256 amount = owedMusu[msg.sender];
    require(amount > 0, "LeaseMkt: nothing owed");
    uint256 target = uint256(uint160(msg.sender));
    require(_isAccount(target), "LeaseMkt: register an account first");
    owedMusu[msg.sender] = 0;
    _transferMusu(target, amount);
    emit OwedClaimed(msg.sender, amount);
  }

  ///////////////////
  // VIEWS

  function numListings() external view returns (uint256) {
    return tokenIndices.length;
  }

  function numCarries() external view returns (uint256) {
    return carries.length;
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

  ///////////////////
  // INTERNALS

  /// @dev snapshot a kami's un-settled delta into the carry list at current terms
  function _carryPending(uint32 tokenIndex) internal {
    Listing storage l = listings[tokenIndex];
    if (!l.staked) return;
    uint256 xp = LibExperience.get(_comps(), l.kamiID);
    uint256 delta = xp > l.xpBase ? xp - l.xpBase : 0;
    l.xpBase = xp;
    if (delta > 0) carries.push(CarryEntry(l.owner, l.renter, l.ownerShareBps, delta));
  }

  function _payout(address to, uint256 amount) internal returns (uint256) {
    uint256 target = uint256(uint160(to));
    if (_isAccount(target)) {
      _transferMusu(target, amount);
      emit Payout(to, amount, false);
    } else {
      owedMusu[to] += amount;
      emit Payout(to, amount, true);
    }
    return amount;
  }

  function _transferMusu(uint256 targetAccID, uint256 amount) internal {
    uint32[] memory indices = new uint32[](1);
    uint256[] memory amts = new uint256[](1);
    indices[0] = MUSU_INDEX;
    amts[0] = amount;
    ItemTransferSystem(_sys(ItemTransferSystemID)).executeTyped(indices, amts, targetAccID);
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
