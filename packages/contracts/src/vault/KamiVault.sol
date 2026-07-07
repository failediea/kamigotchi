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
 * @title KamiVault
 * @notice Trust-minimized custody + revenue-share vault for Kamigotchi kamis on Yominet.
 *
 * Model:
 *  - The vault REGISTERS AND OWNS a Kamigotchi game account. Owner-gated game actions
 *    (stake, unstake, item transfer, operator rotation) can only be performed through
 *    the vault's own functions — there is deliberately NO arbitrary-call passthrough.
 *  - Depositors transfer their Kami721 into the vault; the vault stakes them into its
 *    game account. Harvest MUSU accrues to the vault account's inventory.
 *  - The account's OPERATOR is an EOA whose key is held by the automation layer
 *    (Kamibots). The operator can play (harvest/feed/move) but can never bridge the
 *    NFT out (unstake is owner-gated) nor move the vault's items (transfer is
 *    owner-gated).
 *  - settle() distributes accrued MUSU pro-rata by each kami's XP delta (XP increments
 *    1:1 with collected harvest output), minus a management fee, via the owner-gated
 *    ItemTransferSystem — an in-world, on-chain, arbitrary-percentage split.
 *  - withdraw() unstakes and returns a kami ONLY to its recorded depositor. The admin
 *    cannot redirect it.
 *
 * Known residual risks (documented, not solvable at this layer):
 *  - The operator key (held by Kamibots infra) can KamiSend / sacrifice / market-list
 *    staked kamis — game systems allow this for any operator. Mitigations: reputable
 *    automation provider, on-chain monitoring, and rotateOperator() as a kill switch.
 *  - A DEAD kami cannot be unstaked until revived; withdrawal is blocked until then.
 *  - Kami XP can be spent on level-ups; settle clamps negative deltas to 0. Ops should
 *    level kamis immediately AFTER settle() to minimize attribution loss.
 */
contract KamiVault {
  ///////////////////
  // TYPES

  struct DepositInfo {
    address depositor; // who may withdraw this kami
    uint256 kamiID; // ECS entity id
    uint256 xpBase; // XP snapshot at stake / last settle
    bool staked; // false = held by vault as ERC721, not yet staked in-world
  }

  ///////////////////
  // STATE

  IWorld public immutable world;
  Kami721 public immutable kami721;
  address public admin;

  uint256 public accID; // the vault's game account entity (0 until initialize())
  uint16 public mgmtBps; // management fee in basis points, can only be lowered
  uint256 public reserveMusu; // MUSU kept in the vault at settle (ops budget: food, fees)
  uint256 public mgmtAccID; // game account receiving the management fee

  // deposits keyed by ERC721 token index
  mapping(uint32 => DepositInfo) public deposits;
  uint32[] public tokenIndices; // enumeration of active deposits
  mapping(uint32 => uint256) internal tokenPos; // tokenIndex => position+1 in tokenIndices

  // XP deltas from kamis withdrawn between settles, owed at next settle
  mapping(address => uint256) public carryDelta;
  address[] public carryHolders;

  // payouts held for depositors that had no game account at settle time
  mapping(address => uint256) public owedMusu;

  uint256 private locked = 1; // reentrancy guard

  ///////////////////
  // EVENTS

  event Initialized(uint256 accID, address operator, string name);
  event OperatorRotated(address newOperator);
  event Deposited(address indexed depositor, uint32 indexed tokenIndex, uint256 kamiID);
  event Staked(uint32 indexed tokenIndex);
  event Withdrawn(address indexed depositor, uint32 indexed tokenIndex);
  event Settled(uint256 distributed, uint256 mgmtCut, uint256 totalDelta);
  event Payout(address indexed depositor, uint256 amount, bool held);
  event OwedClaimed(address indexed depositor, uint256 amount);
  event MgmtBpsLowered(uint16 newBps);

  ///////////////////
  // MODIFIERS

  modifier onlyAdmin() {
    require(msg.sender == admin, "KamiVault: not admin");
    _;
  }

  modifier nonReentrant() {
    require(locked == 1, "KamiVault: reentrancy");
    locked = 2;
    _;
    locked = 1;
  }

  ///////////////////
  // SETUP

  constructor(IWorld _world, Kami721 _kami721, uint16 _mgmtBps) {
    require(_mgmtBps <= 5000, "KamiVault: mgmt fee > 50%");
    world = _world;
    kami721 = _kami721;
    admin = msg.sender;
    mgmtBps = _mgmtBps;
  }

  /// @notice registers the vault's game account. one-time.
  function initialize(address operator, string calldata name) external onlyAdmin {
    require(accID == 0, "KamiVault: initialized");
    bytes memory result = AccountRegisterSystem(_sys(AccountRegisterSystemID)).executeTyped(
      operator,
      name
    );
    accID = abi.decode(result, (uint256));
    emit Initialized(accID, operator, name);
  }

  ///////////////////
  // ADMIN

  /// @notice kill switch: rotate the game-account operator (e.g. cut off Kamibots)
  function rotateOperator(address newOperator) external onlyAdmin {
    AccountSetOperatorSystem(_sys(AccountSetOperatorSystemID)).executeTyped(newOperator);
    emit OperatorRotated(newOperator);
  }

  /// @notice management fee can only ever go DOWN (depositor protection)
  function lowerMgmtBps(uint16 newBps) external onlyAdmin {
    require(newBps < mgmtBps, "KamiVault: can only lower");
    mgmtBps = newBps;
    emit MgmtBpsLowered(newBps);
  }

  /// @notice game account that receives the management fee at settle
  function setMgmtAccount(uint256 _mgmtAccID) external onlyAdmin {
    require(_isAccount(_mgmtAccID), "KamiVault: not an account");
    mgmtAccID = _mgmtAccID;
  }

  /// @notice MUSU kept undistributed at settle (ops budget for food, transfer fees)
  function setReserve(uint256 _reserveMusu) external onlyAdmin {
    reserveMusu = _reserveMusu;
  }

  /// @notice fund the operator EOA for gas (Yominet has no faucet)
  function dripOperator(uint256 amount) external onlyAdmin {
    address operator = LibAccount.getOperator(_comps(), accID);
    (bool ok, ) = operator.call{ value: amount }("");
    require(ok, "KamiVault: drip failed");
  }

  receive() external payable {}

  ///////////////////
  // DEPOSIT / STAKE

  /// @notice deposit an out-of-world kami (ERC721) into the vault.
  /// @dev requires prior ERC721 approval. token must be 721_EXTERNAL (unstaked).
  function deposit(uint32 tokenIndex) external nonReentrant {
    require(accID != 0, "KamiVault: not initialized");
    require(deposits[tokenIndex].depositor == address(0), "KamiVault: already deposited");

    kami721.transferFrom(msg.sender, address(this), uint256(tokenIndex));

    uint256 kamiID = LibKami.getByIndex(_comps(), tokenIndex);
    deposits[tokenIndex] = DepositInfo({
      depositor: msg.sender,
      kamiID: kamiID,
      xpBase: 0,
      staked: false
    });
    tokenIndices.push(tokenIndex);
    tokenPos[tokenIndex] = tokenIndices.length;

    emit Deposited(msg.sender, tokenIndex, kamiID);
  }

  /// @notice stake pending deposits into the vault's game account.
  /// @dev callable by anyone (keeper). vault account must be in the bridge room (12).
  function stakeDeposits(uint32[] calldata idxs) external nonReentrant {
    Kami721StakeSystem staker = Kami721StakeSystem(_sys(Kami721StakeSystemID));
    for (uint256 i; i < idxs.length; i++) {
      DepositInfo storage d = deposits[idxs[i]];
      require(d.depositor != address(0), "KamiVault: unknown deposit");
      require(!d.staked, "KamiVault: already staked");

      staker.executeTyped(idxs[i]);
      d.staked = true;
      d.xpBase = LibExperience.get(_comps(), d.kamiID);
      emit Staked(idxs[i]);
    }
  }

  ///////////////////
  // WITHDRAW

  /// @notice return a kami to its depositor. ONLY the depositor may call; the NFT goes
  ///         ONLY to the recorded depositor — the admin cannot redirect it.
  /// @dev if staked: kami must be RESTING and the vault account in the bridge room.
  ///      un-settled XP earned by this kami is carried and paid at the next settle().
  function withdraw(uint32 tokenIndex) external nonReentrant {
    DepositInfo memory d = deposits[tokenIndex];
    require(d.depositor == msg.sender, "KamiVault: not depositor");

    if (d.staked) {
      // credit un-settled earnings attribution before the kami leaves
      uint256 xp = LibExperience.get(_comps(), d.kamiID);
      uint256 delta = xp > d.xpBase ? xp - d.xpBase : 0;
      if (delta > 0) {
        if (carryDelta[msg.sender] == 0) carryHolders.push(msg.sender);
        carryDelta[msg.sender] += delta;
      }
      // unstake: reverts unless RESTING + bridge room; token returns to the vault
      Kami721UnstakeSystem(_sys(Kami721UnstakeSystemID)).executeTyped(tokenIndex);
    }

    _removeDeposit(tokenIndex);
    kami721.transferFrom(address(this), d.depositor, uint256(tokenIndex));
    emit Withdrawn(d.depositor, tokenIndex);
  }

  ///////////////////
  // SETTLEMENT

  /// @notice distribute accrued MUSU: pro-rata by XP delta, minus management fee.
  /// @dev callable by anyone (keeper). each payout is an in-world ItemTransferSystem
  ///      call costing TRANSFER_FEE MUSU, budgeted out of the distributable pool.
  function settle() external nonReentrant {
    require(accID != 0, "KamiVault: not initialized");
    IUintComp comps = _comps();

    // ---- measure the pool
    uint256 bal = LibInventory.getBalanceOf(comps, accID, MUSU_INDEX);
    uint256 n = tokenIndices.length;
    uint256 m = carryHolders.length;
    uint256 feeBudget = (n + m + 1) * TRANSFER_FEE;
    if (bal <= reserveMusu + feeBudget) return; // nothing meaningful to distribute
    uint256 distributable = bal - reserveMusu - feeBudget;

    // ---- pass 1: per-kami XP deltas (+ carried deltas from withdrawn kamis)
    address[] memory payees = new address[](n + m);
    uint256[] memory weights = new uint256[](n + m);
    uint256 totalDelta;

    for (uint256 i; i < n; i++) {
      DepositInfo storage d = deposits[tokenIndices[i]];
      if (!d.staked) continue;
      uint256 xp = LibExperience.get(comps, d.kamiID);
      uint256 delta = xp > d.xpBase ? xp - d.xpBase : 0;
      d.xpBase = xp;
      payees[i] = d.depositor;
      weights[i] = delta;
      totalDelta += delta;
    }
    for (uint256 i; i < m; i++) {
      address holder = carryHolders[i];
      payees[n + i] = holder;
      weights[n + i] = carryDelta[holder];
      totalDelta += carryDelta[holder];
      carryDelta[holder] = 0;
    }
    delete carryHolders;

    if (totalDelta == 0) return; // nothing earned since last settle

    // ---- pass 2: split + transfer
    uint256 mgmtCut = (distributable * mgmtBps) / 10000;
    uint256 payoutPool = distributable - mgmtCut;
    uint256 paidOut;

    for (uint256 i; i < payees.length; i++) {
      if (weights[i] == 0) continue;
      uint256 amount = (payoutPool * weights[i]) / totalDelta;
      if (amount == 0) continue;
      paidOut += _payout(payees[i], amount);
    }

    if (mgmtCut > 0 && mgmtAccID != 0) {
      _transferMusu(mgmtAccID, mgmtCut);
    }

    emit Settled(paidOut, mgmtCut, totalDelta);
  }

  /// @notice claim MUSU that was held because the depositor had no game account
  function claimOwed() external nonReentrant {
    uint256 amount = owedMusu[msg.sender];
    require(amount > 0, "KamiVault: nothing owed");
    uint256 target = uint256(uint160(msg.sender));
    require(_isAccount(target), "KamiVault: register an account first");
    owedMusu[msg.sender] = 0;
    _transferMusu(target, amount);
    emit OwedClaimed(msg.sender, amount);
  }

  ///////////////////
  // VIEWS

  function numDeposits() external view returns (uint256) {
    return tokenIndices.length;
  }

  function pendingXpDelta(uint32 tokenIndex) external view returns (uint256) {
    DepositInfo memory d = deposits[tokenIndex];
    if (!d.staked) return 0;
    uint256 xp = LibExperience.get(_comps(), d.kamiID);
    return xp > d.xpBase ? xp - d.xpBase : 0;
  }

  function musuBalance() external view returns (uint256) {
    return LibInventory.getBalanceOf(_comps(), accID, MUSU_INDEX);
  }

  ///////////////////
  // INTERNALS

  /// @dev pay a depositor: in-world transfer to their account, or hold if none exists
  function _payout(address to, uint256 amount) internal returns (uint256) {
    uint256 target = uint256(uint160(to));
    if (_isAccount(target)) {
      _transferMusu(target, amount);
      emit Payout(to, amount, false);
    } else {
      owedMusu[to] += amount; // held in vault inventory until claimOwed()
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

  function _removeDeposit(uint32 tokenIndex) internal {
    uint256 pos = tokenPos[tokenIndex]; // position+1
    uint256 last = tokenIndices.length;
    if (pos != last) {
      uint32 moved = tokenIndices[last - 1];
      tokenIndices[pos - 1] = moved;
      tokenPos[moved] = pos;
    }
    tokenIndices.pop();
    delete tokenPos[tokenIndex];
    delete deposits[tokenIndex];
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
