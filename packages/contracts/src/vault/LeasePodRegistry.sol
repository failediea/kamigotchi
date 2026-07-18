// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import { RoomPod } from "./RoomPod.sol";

/**
 * @title LeasePodRegistry
 * @notice The protocol directory: which tiles have a parked RoomPod, and where.
 * The dApp builds its tile picker from this (one read), and the ops automation
 * routes leased kamis hub->pod from it. Adding a tile to the marketplace is:
 * deploy a RoomPod, register its account + automation, addPod() — no hub
 * changes, no UI changes, no downtime.
 */
contract LeasePodRegistry {
  address public admin;
  address public immutable hub; // the KamiLeaseMarket all pods sweep to

  address[] public pods;
  mapping(uint32 => address) public podForNode; // nodeIndex => pod (0 = no pod)

  event PodAdded(address indexed pod, uint32 indexed nodeIndex, string label);
  event PodRemoved(address indexed pod, uint32 indexed nodeIndex);

  modifier onlyAdmin() {
    require(msg.sender == admin, "Registry: not admin");
    _;
  }

  constructor(address _hub) {
    hub = _hub;
    admin = msg.sender;
  }

  function addPod(address pod) external onlyAdmin {
    RoomPod p = RoomPod(pod);
    require(address(p.hub()) == hub, "Registry: pod serves another hub");
    require(p.accID() != 0, "Registry: pod not initialized");
    uint32 node = p.nodeIndex();
    require(podForNode[node] == address(0), "Registry: node already served");
    pods.push(pod);
    podForNode[node] = pod;
    emit PodAdded(pod, node, p.label());
  }

  function removePod(address pod) external onlyAdmin {
    uint32 node = RoomPod(pod).nodeIndex();
    require(podForNode[node] == pod, "Registry: not registered");
    delete podForNode[node];
    uint256 n = pods.length;
    for (uint256 i; i < n; i++) {
      if (pods[i] == pod) {
        pods[i] = pods[n - 1];
        pods.pop();
        break;
      }
    }
    emit PodRemoved(pod, node);
  }

  function numPods() external view returns (uint256) {
    return pods.length;
  }

  /// @notice everything the dApp/ops need, in one call
  function allPods()
    external
    view
    returns (
      address[] memory addrs,
      uint32[] memory nodes,
      uint256[] memory accIDs,
      string[] memory labels
    )
  {
    uint256 n = pods.length;
    addrs = new address[](n);
    nodes = new uint32[](n);
    accIDs = new uint256[](n);
    labels = new string[](n);
    for (uint256 i; i < n; i++) {
      RoomPod p = RoomPod(pods[i]);
      addrs[i] = pods[i];
      nodes[i] = p.nodeIndex();
      accIDs[i] = p.accID();
      labels[i] = p.label();
    }
  }
}
