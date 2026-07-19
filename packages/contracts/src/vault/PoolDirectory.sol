// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

/// @title PoolDirectory — the storefront index for Pools-as-a-Service.
/// @notice Lists every lease-market hub the platform frontend displays. The
///         directory owner curates VISIBILITY ONLY — it holds no power over any
///         pool: each hub's admin, custody, fee and funds are entirely its own.
contract PoolDirectory {
  struct Pool {
    address hub;
    address podRegistry;
    address selfRegistry; // zero when the pool has no self-farm stack
    string label;
  }

  address public owner;
  Pool[] internal pools;
  mapping(address => uint256) internal pos; // hub => index+1

  event PoolAdded(address indexed hub, address podRegistry, string label);
  event PoolRemoved(address indexed hub);
  event OwnerChanged(address indexed newOwner);

  modifier onlyOwner() {
    require(msg.sender == owner, "PD: not owner");
    _;
  }

  constructor() {
    owner = msg.sender;
  }

  function setOwner(address newOwner) external onlyOwner {
    require(newOwner != address(0), "PD: zero owner");
    owner = newOwner;
    emit OwnerChanged(newOwner);
  }

  function add(
    address hub,
    address podRegistry,
    address selfRegistry,
    string calldata label
  ) external onlyOwner {
    require(hub != address(0), "PD: zero hub");
    require(pos[hub] == 0, "PD: listed");
    pools.push(Pool(hub, podRegistry, selfRegistry, label));
    pos[hub] = pools.length;
    emit PoolAdded(hub, podRegistry, label);
  }

  function remove(address hub) external onlyOwner {
    uint256 p = pos[hub];
    require(p != 0, "PD: not listed");
    uint256 last = pools.length;
    if (p != last) {
      pools[p - 1] = pools[last - 1];
      pos[pools[p - 1].hub] = p;
    }
    pools.pop();
    delete pos[hub];
    emit PoolRemoved(hub);
  }

  function count() external view returns (uint256) {
    return pools.length;
  }

  function all() external view returns (Pool[] memory) {
    return pools;
  }
}
