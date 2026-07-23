// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import {RenterRoomPodFactory} from "./RenterRoomPodFactory.sol";

/**
 * @title BatchLease
 * @notice Stateless pass-through that funds several signed lease quotes in one
 * transaction, standing in for EIP-5792 batching on wallets that do not
 * support it. No owner, no upgradability, no held funds: every wei is either
 * forwarded to the factory or returned to the caller in the same transaction,
 * and any inner failure reverts the whole batch.
 *
 * Safe as a third-party submitter because the factory attributes everything to
 * the dual-signed quote.renter — pod ownership, refunds, cancel rights, and
 * market attribution. This contract appearing as msg.sender grants it nothing.
 */
contract BatchLease {
    RenterRoomPodFactory public immutable factory;

    error BadFactory();
    error BadPayment();
    error EmptyBatch();
    error LengthMismatch();
    error RefundFailed();

    constructor(RenterRoomPodFactory _factory) {
        if (address(_factory).code.length == 0) revert BadFactory();
        factory = _factory;
    }

    /// @notice Fund every quote in one transaction. values[i] must equal that
    /// quote's setupGasWei + hubGasWei + operatingGasWei (the factory enforces
    /// the exact amount per call and reverts the batch on any mismatch).
    function leaseBatch(
        RenterRoomPodFactory.Quote[] calldata quotes,
        bytes[] calldata quoteSigs,
        bytes[] calldata keeperSigs,
        uint256[] calldata values
    ) external payable returns (address[] memory pods) {
        uint256 n = quotes.length;
        if (n == 0) revert EmptyBatch();
        if (quoteSigs.length != n || keeperSigs.length != n || values.length != n) {
            revert LengthMismatch();
        }

        uint256 total;
        for (uint256 i; i < n; ++i) total += values[i];
        if (msg.value != total) revert BadPayment();

        pods = new address[](n);
        for (uint256 i; i < n; ++i) {
            pods[i] = factory.createPodAndRequestLease{value: values[i]}(
                quotes[i], quoteSigs[i], keeperSigs[i]
            );
        }

        // The factory consumes exactly values[i] per call, so nothing should
        // remain; sweep defensively so no wei can ever strand here.
        uint256 leftover = address(this).balance;
        if (leftover != 0) {
            (bool ok,) = msg.sender.call{value: leftover}("");
            if (!ok) revert RefundFailed();
        }
    }
}
