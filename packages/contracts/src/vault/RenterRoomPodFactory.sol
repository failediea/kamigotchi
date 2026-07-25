// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import {ECDSA} from "openzeppelin/utils/cryptography/ECDSA.sol";
import {IWorld} from "solecs/interfaces/IWorld.sol";

import {LibAccount} from "libraries/LibAccount.sol";
import {MUSU_INDEX} from "libraries/LibInventory.sol";
import {HubGuard} from "./HubGuard.sol";
import {PodRecoveryOperator} from "./PodRecoveryOperator.sol";
import {RoomPod} from "./RoomPod.sol";

interface IRenterFundedLeaseMarket {
    function payItem() external view returns (uint32);
    function operatorAddr() external view returns (address);
    function pendingRenter(uint32 tokenIndex) external view returns (address);
    function listingKamiAccount(uint32 tokenIndex) external view returns (uint256);
    function recoveryReady(uint32 tokenIndex) external view returns (bool);
    function reserveProvisionedLease(
        address renter,
        uint32 tokenIndex,
        address pod,
        string calldata prefs,
        uint16 expectedOwnerShareBps,
        uint32 termSecs
    ) external;
    function prepareProvisionedLease(uint32 tokenIndex) external;
    function activateProvisionedLease(uint32 tokenIndex, string calldata prefs, uint32 termSecs) external;
    function cancelProvisionedLease(uint32 tokenIndex) external;
    function leaseRenter(uint32 tokenIndex) external view returns (address);
    function listingPool(uint32 tokenIndex) external view returns (address);
    function seedPodFeeFloat(uint256 podAccID, uint256 amount) external;
    function setPrefs(uint32 tokenIndex, string calldata prefs) external;
    function extendLease(uint32 tokenIndex, uint32 extraSecs) external;
    function finalizeLease(uint32 tokenIndex) external;
    function confirmReturnedToPool(uint32 tokenIndex) external;
}

interface IRenterFundedRoomPod {
    function accID() external view returns (uint256);
}

/**
 * @title RenterRoomPodFactory
 * @notice Renter-paid, one-RoomPod-per-lease provisioning and gas escrow.
 *
 * The renter's single checkout transaction deploys the selected RoomPod and
 * supplies both setup gas and a refundable operating budget. The immutable
 * quote signer approves terms while the separately hosted immutable keeper
 * attests the reserved random pod operator and advances the constrained setup
 * state machine. Neither can redirect a Kami or administer the contracts.
 *
 * The factory is each RoomPod's nominal admin only so a provable timeout can
 * irreversibly rotate that pod to its own constrained recovery surface. No
 * arbitrary replacement operator or destination is accepted.
 */
contract RenterRoomPodFactory {
    using ECDSA for bytes32;

    uint8 internal constant REQUESTED = 1;
    uint8 internal constant PREPARING = 2;
    uint8 internal constant ACTIVE = 3;
    uint8 internal constant CANCEL_REQUESTED = 4;
    uint8 internal constant FINALIZED = 5;
    uint8 internal constant RECOVERY_PREPARING = 6;
    uint8 internal constant RECOVERY_ACTIVE = 7;
    uint8 internal constant RECOVERY_RETURN = 8;
    uint64 public constant PREPARING_GRACE = 2 days;
    uint64 public constant FINALIZED_GRACE = 2 days;
    /// @notice MUSU seeded to a non-MUSU pod so it can pay its own sweep fees.
    ///         10 sweeps' worth — a lease needs one terminal sweep plus headroom
    ///         for mid-term collections and retries.
    uint256 public constant POD_FEE_FLOAT_SEED = 150;

    struct Quote {
        address renter;
        uint32 tokenIndex;
        uint32 nodeIndex;
        address operator;
        uint16 expectedOwnerShareBps;
        uint32 termSecs;
        uint128 setupGasWei;
        uint128 hubGasWei;
        uint128 operatingGasWei;
        uint64 deadline;
        bytes32 nonce;
        string label;
        string accountName;
        string prefs;
    }

    struct Request {
        address renter;
        address pod;
        uint256 gasBudget;
        uint32 termSecs;
        uint64 requestedAt;
        uint8 stage;
    }

    IWorld public immutable world;
    IRenterFundedLeaseMarket public immutable market;
    address public immutable quoteSigner;
    address public immutable keeper;
    /// @notice shared PodRecoveryOperator implementation cloned by every pod
    address public immutable recoveryOpImpl;

    mapping(bytes32 => bool) public quoteUsed;
    mapping(bytes32 => bool) public nonceUsed;
    mapping(uint32 => Request) public requests;
    mapping(uint32 => string) internal _prefs;
    mapping(uint32 => address) public latestPodForKami;
    mapping(address => uint256) public owedEth;
    address[] internal _pods;
    uint256 private locked = 1;

    error ActiveRequest();
    error BadPayment();
    error BadQuote();
    error BadStage();
    error BudgetTooLow();
    error ClaimFailed();
    error ExpiredQuote();
    error Grace();
    error NotOperator();
    error NotProvisioner();
    error NotRenter();
    error NothingOwed();
    error OperatorFundingFailed();
    error QuoteAlreadyUsed();
    error Reentrancy();
    error TransferFailed();

    event RenterPodCreated(
        address indexed renter,
        uint32 indexed tokenIndex,
        uint32 indexed nodeIndex,
        address pod,
        address operator,
        uint256 setupGasWei,
        uint256 hubGasWei,
        uint256 operatingGasWei,
        bytes32 nonce
    );
    event LeasePreparing(uint32 indexed tokenIndex, address indexed pod);
    event LeaseActivated(uint32 indexed tokenIndex, address indexed renter, address indexed pod);
    event PreparingCancellationRequested(uint32 indexed tokenIndex, address indexed renter, address indexed pod);
    event RequestCancelled(uint32 indexed tokenIndex, address indexed renter, uint256 refund);
    event GasPulled(uint32 indexed tokenIndex, address indexed operator, uint256 amount);
    event GasReturned(uint32 indexed tokenIndex, address indexed operator, uint256 amount);
    event GasToppedUp(uint32 indexed tokenIndex, address indexed renter, uint256 amount);
    event GasRefunded(uint32 indexed tokenIndex, address indexed renter, uint256 amount);
    event EthOwed(address indexed renter, uint256 amount);
    event PreparedKamiRouted(uint32 indexed tokenIndex, address indexed pod);
    event PodRecoveryEntered(uint32 indexed tokenIndex, address indexed pod, uint8 priorStage);
    event RecoveryReadyToReturn(uint32 indexed tokenIndex, address indexed pod);
    event RecoveredKamiReturned(uint32 indexed tokenIndex, address indexed pod);

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotProvisioner();
        _;
    }

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    constructor(IWorld _world, address _market, address _quoteSigner, address _keeper) {
        if (
            _market.code.length == 0 || _quoteSigner == address(0) || _keeper == address(0)
                || _quoteSigner == _keeper
        ) revert BadQuote();
        world = _world;
        market = IRenterFundedLeaseMarket(_market);
        quoteSigner = _quoteSigner;
        keeper = _keeper;
        // One shared implementation for every pod's recovery operator. Pods clone
        // it, so neither RoomPod nor this factory has to carry its creation code
        // — that nesting was consuming most of this contract's EIP-170 headroom.
        recoveryOpImpl = address(new PodRecoveryOperator());
    }

    /// @notice Any submitter may fund a dual-signed quote; pod ownership,
    /// refunds, cancel rights, and market attribution always follow the signed
    /// quote.renter, so a batching periphery gains nothing by being msg.sender.
    /// The zero-renter check preserves requests[].renter as the liveness
    /// sentinel that ActiveRequest relies on.
    function createPodAndRequestLease(
        Quote calldata quote,
        bytes calldata quoteSignature,
        bytes calldata keeperSignature
    )
        external
        payable
        nonReentrant
        returns (address pod)
    {
        if (msg.value != _quoteFunding(quote)) revert BadPayment();
        pod = _createPodAndRequestLease(quote, quoteSignature, keeperSignature);
    }

    /// @notice Fund several dual-signed quotes in ONE transaction — native
    /// batching for wallets without EIP-5792, no periphery contract needed.
    /// msg.value must equal the sum of every quote's funding; any failure
    /// reverts the whole batch. The sum is checked before any pod deploys so
    /// escrowed budgets of other leases can never even transiently back an
    /// underfunded batch.
    function createPodsAndRequestLeases(
        Quote[] calldata quotes,
        bytes[] calldata quoteSignatures,
        bytes[] calldata keeperSignatures
    )
        external
        payable
        nonReentrant
        returns (address[] memory pods)
    {
        uint256 n = quotes.length;
        if (n == 0 || quoteSignatures.length != n || keeperSignatures.length != n) revert BadQuote();
        uint256 total;
        for (uint256 i; i < n; ++i) {
            total += _quoteFunding(quotes[i]);
        }
        if (msg.value != total) revert BadPayment();
        pods = new address[](n);
        for (uint256 i; i < n; ++i) {
            pods[i] = _createPodAndRequestLease(quotes[i], quoteSignatures[i], keeperSignatures[i]);
        }
    }

    function _quoteFunding(Quote calldata quote) internal pure returns (uint256) {
        return uint256(quote.setupGasWei) + uint256(quote.hubGasWei) + uint256(quote.operatingGasWei);
    }

    function _createPodAndRequestLease(
        Quote calldata quote,
        bytes calldata quoteSignature,
        bytes calldata keeperSignature
    )
        internal
        returns (address pod)
    {
        if (requests[quote.tokenIndex].renter != address(0)) revert ActiveRequest();
        if (quote.renter == address(0) || quote.operator == address(0)) revert BadQuote();
        if (block.timestamp > quote.deadline) revert ExpiredQuote();

        bytes32 digest = quoteDigest(quote);
        if (quoteUsed[digest] || nonceUsed[quote.nonce]) revert QuoteAlreadyUsed();
        if (digest.recover(quoteSignature) != quoteSigner || digest.recover(keeperSignature) != keeper) {
            revert BadQuote();
        }
        quoteUsed[digest] = true;
        nonceUsed[quote.nonce] = true;

        RoomPod created = new RoomPod(
            world, address(market), quote.nodeIndex, quote.label, market.payItem(), recoveryOpImpl
        );
        created.bindLease(quote.tokenIndex);
        created.initialize(quote.operator, quote.accountName);
        pod = address(created);

        // A non-MUSU pod earns only payItem, but the game charges its transfer
        // fee in MUSU — so without a seeded float this pod could never sweep its
        // own earnings to the hub and they would strand permanently. Seed it now,
        // from the hub's float, while the hub still has a chance to say no: a dry
        // float must block checkout rather than mint a lease that cannot pay out.
        if (market.payItem() != MUSU_INDEX) {
            market.seedPodFeeFloat(created.accID(), POD_FEE_FLOAT_SEED);
        }

        requests[quote.tokenIndex] = Request({
            renter: quote.renter,
            pod: pod,
            gasBudget: quote.operatingGasWei,
            termSecs: quote.termSecs,
            requestedAt: uint64(block.timestamp),
            stage: REQUESTED
        });
        _prefs[quote.tokenIndex] = quote.prefs;
        latestPodForKami[quote.tokenIndex] = pod;
        _pods.push(pod);

        if (quote.setupGasWei != 0) {
            (bool funded,) = quote.operator.call{value: quote.setupGasWei}("");
            if (!funded) revert OperatorFundingFailed();
        }
        if (quote.hubGasWei != 0) {
            (bool funded,) = keeper.call{value: quote.hubGasWei}("");
            if (!funded) revert OperatorFundingFailed();
        }

        market.reserveProvisionedLease(
            quote.renter,
            quote.tokenIndex,
            pod,
            quote.prefs,
            quote.expectedOwnerShareBps,
            quote.termSecs
        );

        _emitCreated(quote, pod);
    }

    /// @dev Hoisted out of createPodAndRequestLease: emitting the 9-field event
    /// inline exceeds legacy codegen's stack there (the repo's test profile
    /// compiles without via-IR).
    function _emitCreated(Quote calldata quote, address pod) private {
        emit RenterPodCreated(
            quote.renter,
            quote.tokenIndex,
            quote.nodeIndex,
            pod,
            quote.operator,
            quote.setupGasWei,
            quote.hubGasWei,
            quote.operatingGasWei,
            quote.nonce
        );
    }

    /// @notice Called by the fixed Kamibots provisioner after registration and
    /// walking succeed. Custody moves owner pool -> hub; paid time is still zero.
    function markLeasePreparing(uint32 tokenIndex) external onlyKeeper nonReentrant {
        Request storage request = requests[tokenIndex];
        if (request.stage != REQUESTED) revert BadStage();
        market.prepareProvisionedLease(tokenIndex);
        request.stage = PREPARING;
        // Restart the grace clock on the stage it actually guards. It was stamped
        // at pod creation and never refreshed, so a lease dispatched near the
        // 2-day mark was cancellable before it could ever activate.
        request.requestedAt = uint64(block.timestamp);
        emit LeasePreparing(tokenIndex, request.pod);
    }

    /// @notice After the pool-to-hub send cooldown, the keeper asks the sealed
    /// HubGuard to route only to this request's exact RoomPod.
    function routePreparedKami(uint32 tokenIndex) external onlyKeeper nonReentrant {
        Request storage request = requests[tokenIndex];
        if (request.stage != PREPARING) revert BadStage();
        HubGuard(market.operatorAddr()).routeToPendingPod(tokenIndex, request.pod);
        emit PreparedKamiRouted(tokenIndex, request.pod);
    }

    /// @notice Called only after the Kami is in this request's exact RoomPod and
    /// Kamibots is ready. The market independently verifies arrival, then starts
    /// the paid term.
    function activateProvisionedLease(uint32 tokenIndex) external onlyKeeper nonReentrant {
        Request storage request = requests[tokenIndex];
        if (request.stage != PREPARING) revert BadStage();
        market.activateProvisionedLease(tokenIndex, _prefs[tokenIndex], request.termSecs);
        request.stage = ACTIVE;
        emit LeaseActivated(tokenIndex, request.renter, request.pod);
    }

    /// @notice Before custody moves, the renter can cancel immediately. After
    /// the setup grace, anyone can clear an abandoned reservation so a renter
    /// cannot lock an owner's listing forever. Every unused operating-gas wei
    /// still refunds only to the recorded renter.
    function cancelBeforeDispatch(uint32 tokenIndex) external nonReentrant {
        Request storage request = requests[tokenIndex];
        if (request.stage != REQUESTED) revert BadStage();
        if (
            request.renter != msg.sender
                && block.timestamp < uint256(request.requestedAt) + PREPARING_GRACE
        ) revert Grace();
        market.cancelProvisionedLease(tokenIndex);
        _refundAndClear(tokenIndex, false);
    }

    /// @notice If provisioning stalls after custody moved, the renter can force a
    /// constrained return immediately, and anyone may after two days. Automation
    /// can return the Kami only to its recorded Personal Rental Pool.
    function requestPreparingCancellation(uint32 tokenIndex) external {
        Request storage request = requests[tokenIndex];
        if (request.stage != PREPARING) revert BadStage();
        // Renter fast-path, permissionless fallback — the same shape as
        // cancelBeforeDispatch. Renter-ONLY would be wrong: a silent renter would
        // trap the OWNER's kami with no way out, which is why the owner drives
        // this in testPreparingTimeoutReturnsOnlyToRecordedPool.
        //
        // The real defect was that the grace was not a grace: requestedAt was
        // stamped at pod creation and never refreshed, so a lease dispatched near
        // the 2-day mark was killable by a bystander before it could ever
        // activate. markLeasePreparing now restarts the clock, so this window
        // opens only on a genuinely stalled provision.
        if (
            request.renter != msg.sender
                && block.timestamp < uint256(request.requestedAt) + PREPARING_GRACE
        ) revert Grace();
        request.stage = CANCEL_REQUESTED;
        emit PreparingCancellationRequested(tokenIndex, request.renter, request.pod);
    }

    /// @notice Permissionless after the market proves the Kami is safely back
    /// in its owner's pool. Clears the reservation and refunds operating gas.
    function finalizePreparingCancellation(uint32 tokenIndex) external nonReentrant {
        Request storage request = requests[tokenIndex];
        if (request.stage != CANCEL_REQUESTED) revert BadStage();
        market.cancelProvisionedLease(tokenIndex);
        _refundAndClear(tokenIndex, false);
    }

    /// @notice Recover a PREPARING Kami that is still in the sealed hub. The
    /// destination is read from the market; callers cannot supply one.
    function recoverPreparingFromHub(uint32 tokenIndex) external nonReentrant {
        Request storage request = requests[tokenIndex];
        if (request.stage != CANCEL_REQUESTED) revert BadStage();
        HubGuard(market.operatorAddr()).returnPendingToPool(tokenIndex);
        market.cancelProvisionedLease(tokenIndex);
        _refundAndClear(tokenIndex, false);
    }

    /// @notice Irreversibly rotate a timed-out pod to a fresh recovery operator.
    /// This destroys the Kamibots EOA's authority for this pod only.
    /// @param salt CREATE2 salt for the pod's recovery operator. If the derived
    /// address has been squatted in the game's global operator namespace the
    /// whole call reverts with no state change — retry with any other salt.
    function enterPodRecovery(uint32 tokenIndex, bytes32 salt) external nonReentrant {
        Request storage request = requests[tokenIndex];
        uint8 priorStage = request.stage;
        if (priorStage == CANCEL_REQUESTED) {
            // The renter already waited PREPARING_GRACE before reaching this stage.
        } else if (priorStage == ACTIVE) {
            // A timeout must hold INDEPENDENTLY. The old `&&` short-circuited the
            // moment the settler called finalizeLease directly (leaseRenter -> 0
            // without advancing the factory stage), letting anyone irreversibly
            // burn a healthy pod with zero elapsed grace — killing pullGas and
            // closing finalizeGasRefund with the kami still inside.
            if (
                !market.recoveryReady(tokenIndex)
                    && block.timestamp < uint256(request.requestedAt) + FINALIZED_GRACE
            ) revert Grace();
        } else if (priorStage == FINALIZED) {
            if (block.timestamp < uint256(request.requestedAt) + FINALIZED_GRACE) revert Grace();
        } else {
            revert BadStage();
        }
        if (market.listingKamiAccount(tokenIndex) != IRenterFundedRoomPod(request.pod).accID()) {
            revert BadStage();
        }
        RoomPod(request.pod).enterRecoveryMode(salt);
        request.stage = priorStage == CANCEL_REQUESTED ? RECOVERY_PREPARING : RECOVERY_ACTIVE;
        emit PodRecoveryEntered(tokenIndex, request.pod, priorStage);
    }

    function stopRecoveryHarvest(uint32 tokenIndex) external nonReentrant returns (bool stopped) {
        Request storage request = requests[tokenIndex];
        if (request.stage != RECOVERY_PREPARING && request.stage != RECOVERY_ACTIVE) revert BadStage();
        stopped = RoomPod(request.pod).stopHarvestForRecovery();
    }

    /// @notice Sweep and finalize accounting before allowing the constrained
    /// return. If the Kami is still harvesting, market finalization reverts and
    /// the caller retries stopRecoveryHarvest after its cooldown.
    function prepareRecoveryReturn(uint32 tokenIndex) external nonReentrant {
        Request storage request = requests[tokenIndex];
        if (request.stage != RECOVERY_PREPARING && request.stage != RECOVERY_ACTIVE) revert BadStage();
        RoomPod(request.pod).sweepMusu();
        if (request.stage == RECOVERY_ACTIVE && market.leaseRenter(tokenIndex) == request.renter) {
            market.finalizeLease(tokenIndex);
        }
        request.stage = RECOVERY_RETURN;
        emit RecoveryReadyToReturn(tokenIndex, request.pod);
    }

    /// @notice Permissionless final recovery step. RoomPod hardcodes the exact
    /// registered pool; the market then independently verifies arrival.
    function returnRecoveredKami(uint32 tokenIndex) external nonReentrant {
        Request storage request = requests[tokenIndex];
        if (request.stage != RECOVERY_RETURN) revert BadStage();
        RoomPod(request.pod).returnKamiToPool();
        // same listing-deleted hazard as finalizeGasRefund: never let a missing
        // listing block the renter's refund
        if (market.pendingRenter(tokenIndex) != address(0)) market.cancelProvisionedLease(tokenIndex);
        else if (market.listingPool(tokenIndex) != address(0)) {
            market.confirmReturnedToPool(tokenIndex);
        }
        address pod = request.pod;
        _refundAndClear(tokenIndex, true);
        emit RecoveredKamiReturned(tokenIndex, pod);
    }

    /// @notice The exact on-chain RoomPod operator may pull only this lease's
    /// renter-funded budget. During an active lease the market must still show
    /// the same renter, preventing pulls after finalization.
    function pullGas(uint32 tokenIndex, uint256 amount) external nonReentrant {
        Request storage request = requests[tokenIndex];
        if (request.stage != PREPARING && request.stage != ACTIVE) revert BadStage();
        if (request.stage == ACTIVE && market.leaseRenter(tokenIndex) != request.renter) revert BadStage();
        if (request.gasBudget < amount) revert BudgetTooLow();
        if (msg.sender != _operator(request.pod)) revert NotOperator();
        request.gasBudget -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit GasPulled(tokenIndex, msg.sender, amount);
    }

    function returnGas(uint32 tokenIndex) external payable {
        Request storage request = requests[tokenIndex];
        if (request.stage != PREPARING && request.stage != ACTIVE) revert BadStage();
        if (msg.sender != _operator(request.pod)) revert NotOperator();
        request.gasBudget += msg.value;
        emit GasReturned(tokenIndex, msg.sender, msg.value);
    }

    function topUpGas(uint32 tokenIndex) external payable {
        Request storage request = requests[tokenIndex];
        if (request.renter != msg.sender) revert NotRenter();
        if (request.stage != PREPARING && request.stage != ACTIVE) revert BadStage();
        request.gasBudget += msg.value;
        emit GasToppedUp(tokenIndex, msg.sender, msg.value);
    }

    /// @notice Authenticated renter preference update. The market emits the
    /// event consumed by the Kamibots worker; no API key or operator key is
    /// ever exposed to the browser.
    function updateLeasePrefs(uint32 tokenIndex, string calldata newPrefs) external nonReentrant {
        Request storage request = requests[tokenIndex];
        if (request.renter != msg.sender) revert NotRenter();
        if (request.stage != ACTIVE) revert BadStage();
        if (bytes(newPrefs).length > 3_000) revert BadQuote();
        _prefs[tokenIndex] = newPrefs;
        market.setPrefs(tokenIndex, newPrefs);
    }

    /// @notice Extend and add the renter's new operating budget atomically.
    /// The UI quotes the added budget from current gas price and strategy.
    function extendLeaseAndTopUp(uint32 tokenIndex, uint32 extraSecs) external payable nonReentrant {
        Request storage request = requests[tokenIndex];
        if (request.renter != msg.sender) revert NotRenter();
        if (request.stage != ACTIVE) revert BadStage();
        if (msg.value == 0) revert BudgetTooLow();
        request.gasBudget += msg.value;
        market.extendLease(tokenIndex, extraSecs);
        emit GasToppedUp(tokenIndex, msg.sender, msg.value);
    }

    /// @notice Once the market has finalized the lease, anyone may trigger the
    /// remaining operating-budget refund to the recorded renter.
    function finalizeGasRefund(uint32 tokenIndex) external nonReentrant {
        Request storage request = requests[tokenIndex];
        if (request.stage == ACTIVE && market.leaseRenter(tokenIndex) != request.renter) {
            request.stage = FINALIZED;
            request.requestedAt = uint64(block.timestamp);
        }
        if (request.stage != FINALIZED || market.leaseRenter(tokenIndex) == request.renter) revert BadStage();
        // The owner's documented exit (requestReturn -> permissionless
        // clearReturned) DELETES the listing, after which confirmReturnedToPool
        // reverts NotOwner() forever — stranding the renter's escrow and, because
        // requests[tokenIndex].renter stays set, barring that kami from ever being
        // leased again. A deleted listing already proves the kami left the market,
        // so treat its absence as the confirmation rather than a failure.
        if (market.listingPool(tokenIndex) != address(0)) {
            market.confirmReturnedToPool(tokenIndex);
        }
        _refundAndClear(tokenIndex, true);
    }

    /// @notice The dedicated pod operator pays the final stop/sweep/accounting
    /// transaction from the renter-funded gas it already holds. The market sees
    /// only this immutable factory, and this factory verifies the exact operator.
    function finalizeMarketLease(uint32 tokenIndex) external nonReentrant {
        Request storage request = requests[tokenIndex];
        if (request.stage != ACTIVE || msg.sender != _operator(request.pod)) revert NotOperator();
        market.finalizeLease(tokenIndex);
        request.stage = FINALIZED;
        request.requestedAt = uint64(block.timestamp);
    }

    function claimEth() external nonReentrant {
        uint256 amount = owedEth[msg.sender];
        if (amount == 0) revert NothingOwed();
        owedEth[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert ClaimFailed();
    }

    function prefs(uint32 tokenIndex) external view returns (string memory) {
        return _prefs[tokenIndex];
    }

    function quoteDigest(Quote calldata quote) public view returns (bytes32) {
        bytes32 terms = keccak256(
            abi.encode(
                quote.renter,
                quote.tokenIndex,
                quote.nodeIndex,
                quote.operator,
                quote.expectedOwnerShareBps,
                quote.termSecs,
                quote.setupGasWei,
                quote.hubGasWei,
                quote.operatingGasWei,
                quote.deadline,
                quote.nonce
            )
        );
        bytes32 text = keccak256(
            abi.encode(
                keccak256(bytes(quote.label)),
                keccak256(bytes(quote.accountName)),
                keccak256(bytes(quote.prefs))
            )
        );
        bytes32 payload = keccak256(abi.encode(address(this), block.chainid, terms, text));
        return ECDSA.toEthSignedMessageHash(payload);
    }

    function allPods() external view returns (address[] memory) {
        return _pods;
    }

    function numPods() external view returns (uint256) {
        return _pods.length;
    }

    function _refundAndClear(uint32 tokenIndex, bool ended) internal {
        Request memory request = requests[tokenIndex];
        uint256 refund = request.gasBudget;
        delete requests[tokenIndex];
        delete _prefs[tokenIndex];
        if (refund != 0) _sendOrOwe(request.renter, refund);
        if (ended) emit GasRefunded(tokenIndex, request.renter, refund);
        else emit RequestCancelled(tokenIndex, request.renter, refund);
    }

    function _operator(address pod) internal view returns (address) {
        return LibAccount.getOperator(world.components(), IRenterFundedRoomPod(pod).accID());
    }

    function _sendOrOwe(address renter, uint256 amount) internal {
        (bool ok,) = renter.call{value: amount, gas: 50_000}("");
        if (!ok) {
            owedEth[renter] += amount;
            emit EthOwed(renter, amount);
        }
    }

    receive() external payable {}
}
