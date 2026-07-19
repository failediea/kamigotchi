// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import { Script, console } from "forge-std/Script.sol";
import { IWorld } from "solecs/interfaces/IWorld.sol";

import { LeasePodRegistry } from "vault/LeasePodRegistry.sol";
import { RoomPod } from "vault/RoomPod.sol";

/**
 * Deploys the LeasePodRegistry + one RoomPod per supported tile against a live
 * hub (KamiLeaseMarket). Each pod gets its OWN parked game account + operator.
 *
 * Env:
 *  WORLD_ADDR      — World
 *  HUB_ADDR        — the KamiLeaseMarket the pods sweep to
 *  REGISTRY_ADDR   — optional: existing registry (else a new one is deployed)
 *  POD_NODES       — comma-free packed as N envs: POD1_NODE, POD1_LABEL,
 *                    POD1_OPERATOR, POD1_NAME ... up to POD9_*
 *  POD_COUNT       — how many PODn_* blocks to read
 *
 * forge script script/DeployLeasePods.s.sol:DeployLeasePods \
 *   --rpc-url $YOMINET_RPC --broadcast --private-key $DEPLOYER_KEY --legacy
 */
contract DeployLeasePods is Script {
  function run() external {
    IWorld world = IWorld(vm.envAddress("WORLD_ADDR"));
    address hub = vm.envAddress("HUB_ADDR");
    uint256 count = vm.envUint("POD_COUNT");

    vm.startBroadcast();

    address registryAddr = vm.envOr("REGISTRY_ADDR", address(0));
    LeasePodRegistry registry = registryAddr == address(0)
      ? new LeasePodRegistry(hub)
      : LeasePodRegistry(registryAddr);
    console.log("LeasePodRegistry:", address(registry));

    for (uint256 i = 1; i <= count; i++) {
      string memory p = string.concat("POD", vm.toString(i));
      uint32 node = uint32(vm.envUint(string.concat(p, "_NODE")));
      string memory label = vm.envString(string.concat(p, "_LABEL"));
      address operator = vm.envAddress(string.concat(p, "_OPERATOR"));
      string memory name = vm.envString(string.concat(p, "_NAME"));

      RoomPod pod = new RoomPod(world, hub, node, label, uint32(vm.envOr("PAY_ITEM", uint256(1))));
      pod.initialize(operator, name);
      registry.addPod(address(pod));

      console.log("RoomPod:", address(pod));
      console.log("  node:", node);
      console.log("  label:", label);
      console.log("  accID:", pod.accID());
      console.log("  operator:", operator);
      console.log("  name:", name);
    }

    vm.stopBroadcast();
  }
}
