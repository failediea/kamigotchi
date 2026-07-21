// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import {ECDSA} from "openzeppelin/utils/cryptography/ECDSA.sol";
import {IWorld} from "solecs/interfaces/IWorld.sol";

import {LibAccount} from "libraries/LibAccount.sol";
import {RoomPod} from "./RoomPod.sol";

interface IRenterFundedLeaseMarket {
    function payItem() external view returns (uint32);
    function operatorAddr() external view returns (address);
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
    function setPrefs(uint32 tokenIndex, string calldata prefs) external;
    function extendLease(uint32 tokenIndex, uint32 extraSecs) external;
    function finalizeLease(uint32 tokenIndex) external;
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
 * provisioning signer can advance only the constrained setup state machine;
 * it cannot withdraw ETH, redirect a Kami, rotate an operator, change terms,
 * upgrade, pause or administer either this factory or a deployed RoomPod.
 *
 * The factory is each RoomPod's nominal admin but intentionally exposes no
 * forwarding or rotation function, permanently sealing the operator selected
 * in the renter-signed quote.
 */
contract RenterRoomPodFactory {
    using ECDSA for bytes32;

    uint8 internal constant REQUESTED = 1;
    uint8 internal constant PREPARING = 2;
    uint8 internal constant ACTIVE = 3;
    uint8 internal constant CANCEL_REQUESTED = 4;
    uint64 public constant PREPARING_GRACE = 2 days;

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
    address public immutable provisioningSigner;

    mapping(bytes32 => bool) public quoteUsed;
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

    modifier onlyProvisioner() {
        if (msg.sender != provisioningSigner) revert NotProvisioner();
        _;
    }

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    constructor(IWorld _world, address _market, address _provisioningSigner) {
        if (_market.code.length == 0 || _provisioningSigner == address(0)) revert BadQuote();
        world = _world;
        market = IRenterFundedLeaseMarket(_market);
        // The quote signer is also the market's tightly scoped automation EOA.
        // Renter-paid hubGas therefore funds prepare, one constrained hub send,
        // and activation without introducing another privileged wallet.
        if (market.operatorAddr() != _provisioningSigner) revert BadQuote();
        provisioningSigner = _provisioningSigner;
    }

    function createPodAndRequestLease(Quote calldata quote, bytes calldata signature)
        external
        payable
        nonReentrant
        returns (address pod)
    {
        _clearEndedRequest(quote.tokenIndex);
        if (requests[quote.tokenIndex].renter != address(0)) revert ActiveRequest();
        if (quote.renter != msg.sender || quote.operator == address(0)) revert BadQuote();
        if (block.timestamp > quote.deadline) revert ExpiredQuote();
        if (
            msg.value
                != uint256(quote.setupGasWei) + uint256(quote.hubGasWei) + uint256(quote.operatingGasWei)
        ) revert BadPayment();

        bytes32 digest = quoteDigest(quote);
        if (quoteUsed[digest]) revert QuoteAlreadyUsed();
        if (digest.recover(signature) != provisioningSigner) revert BadQuote();
        quoteUsed[digest] = true;

        RoomPod created = new RoomPod(world, address(market), quote.nodeIndex, quote.label, market.payItem());
        created.initialize(quote.operator, quote.accountName);
        pod = address(created);

        requests[quote.tokenIndex] = Request({
            renter: msg.sender,
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
            (bool funded,) = market.operatorAddr().call{value: quote.hubGasWei}("");
            if (!funded) revert OperatorFundingFailed();
        }

        market.reserveProvisionedLease(
            msg.sender,
            quote.tokenIndex,
            pod,
            quote.prefs,
            quote.expectedOwnerShareBps,
            quote.termSecs
        );

        emit RenterPodCreated(
            msg.sender,
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
    function markLeasePreparing(uint32 tokenIndex) external onlyProvisioner nonReentrant {
        Request storage request = requests[tokenIndex];
        if (request.stage != REQUESTED) revert BadStage();
        market.prepareProvisionedLease(tokenIndex);
        request.stage = PREPARING;
        emit LeasePreparing(tokenIndex, request.pod);
    }

    /// @notice Called only after the Kami is in this request's exact RoomPod and
    /// Kamibots is ready. The market independently verifies arrival, then starts
    /// the paid term.
    function activateProvisionedLease(uint32 tokenIndex) external onlyProvisioner nonReentrant {
        Request storage request = requests[tokenIndex];
        if (request.stage != PREPARING) revert BadStage();
        market.activateProvisionedLease(tokenIndex, _prefs[tokenIndex], request.termSecs);
        request.stage = ACTIVE;
        emit LeaseActivated(tokenIndex, request.renter, request.pod);
    }

    /// @notice Before custody moves, the renter can cancel and recover every
    /// unused operating-gas wei. Deployment/setup gas was already consumed.
    function cancelBeforeDispatch(uint32 tokenIndex) external nonReentrant {
        Request storage request = requests[tokenIndex];
        if (request.renter != msg.sender) revert NotRenter();
        if (request.stage != REQUESTED) revert BadStage();
        market.cancelProvisionedLease(tokenIndex);
        _refundAndClear(tokenIndex, false);
    }

    /// @notice If provisioning stalls after custody moved, the renter can force
    /// a constrained return after two days. Automation can return the Kami only
    /// to its recorded Personal Rental Pool; it cannot redirect it.
    function requestPreparingCancellation(uint32 tokenIndex) external {
        Request storage request = requests[tokenIndex];
        if (request.renter != msg.sender) revert NotRenter();
        if (request.stage != PREPARING) revert BadStage();
        if (block.timestamp < uint256(request.requestedAt) + PREPARING_GRACE) revert Grace();
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
        if (request.stage != ACTIVE || market.leaseRenter(tokenIndex) == request.renter) revert BadStage();
        _refundAndClear(tokenIndex, true);
    }

    /// @notice The dedicated pod operator pays the final stop/sweep/accounting
    /// transaction from the renter-funded gas it already holds. The market sees
    /// only this immutable factory, and this factory verifies the exact operator.
    function finalizeMarketLease(uint32 tokenIndex) external nonReentrant {
        Request storage request = requests[tokenIndex];
        if (request.stage != ACTIVE || msg.sender != _operator(request.pod)) revert NotOperator();
        market.finalizeLease(tokenIndex);
        _refundAndClear(tokenIndex, true);
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

    function _clearEndedRequest(uint32 tokenIndex) internal {
        Request storage request = requests[tokenIndex];
        if (request.stage == ACTIVE && market.leaseRenter(tokenIndex) != request.renter) {
            _refundAndClear(tokenIndex, true);
        }
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
