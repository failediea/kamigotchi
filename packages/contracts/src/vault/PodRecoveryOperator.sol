// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

/**
 * @title PodRecoveryOperator
 * @notice A throwaway operator address for one RoomPod's recovery mode.
 *
 * RoomPod used to rotate its game account's operator to `address(this)`. That
 * looked safe — one pod, one unique address — but the game's operator namespace
 * is a GLOBAL first-come map (`AccountSetOperatorSystem` reverts on
 * `operatorInUse`, and account registration is permissionless on the live
 * world). A pod's address is public the moment it is deployed, both in the
 * `RenterPodCreated` event and by precomputing the factory's CREATE nonce, so
 * anyone could claim it as their own account's operator for the cost of one
 * throwaway EOA and permanently disarm that pod's only keeper-independent
 * escape hatch.
 *
 * The fix is to make the rotation target RETRYABLE. This contract is deployed
 * with CREATE2 from a caller-supplied salt, so a squatted address is answered
 * by simply picking another salt. The whole rotation reverts atomically when
 * the address is taken, which means a failed attempt burns no state.
 *
 * It holds nothing and decides nothing: its only power is to forward a call on
 * behalf of the pod that deployed it, so it adds no trust surface. Every guard
 * that matters still lives in RoomPod.
 */
contract PodRecoveryOperator {
    /// @notice the RoomPod that deployed this operator; the only permitted caller
    address public immutable pod;

    error NotPod();

    constructor() {
        pod = msg.sender;
    }

    /// @notice Forward one call so it originates from THIS address, which is what
    ///         the game resolves as the pod account's operator.
    /// @dev Deliberately unrestricted in `target`/`data` — the pod is the only
    ///      caller and every destination is already fixed in RoomPod's recovery
    ///      functions, so narrowing here would duplicate those guards without
    ///      adding any.
    function exec(address target, bytes calldata data) external returns (bytes memory) {
        if (msg.sender != pod) revert NotPod();
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            // bubble the original revert so callers keep the game's own reason
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}
