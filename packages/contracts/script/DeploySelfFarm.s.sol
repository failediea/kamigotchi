// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import { Script, console } from "forge-std/Script.sol";
import { IWorld } from "solecs/interfaces/IWorld.sol";

import { LeasePodRegistry } from "vault/LeasePodRegistry.sol";
import { RoomPod } from "vault/RoomPod.sol";
import { HarvestGuard } from "vault/HarvestGuard.sol";

/**
 * Deploys the SELF-FARM stack: HarvestGuard (the pod operator that renters
 * drive directly) + its RoomPod + a dedicated self-farm LeasePodRegistry.
 *
 * Env: WORLD_ADDR, HUB_ADDR, KEEPER_ADDR, POD_NODE, POD_LABEL, POD_NAME,
 *      SELF_REGISTRY_ADDR (optional; new one deployed if unset)
 */
contract DeploySelfFarm is Script {
  function run() external {
    IWorld world = IWorld(vm.envAddress("WORLD_ADDR"));
    address hub = vm.envAddress("HUB_ADDR");
    address keeper = vm.envAddress("KEEPER_ADDR");
    uint32 node = uint32(vm.envUint("POD_NODE"));
    string memory label = vm.envString("POD_LABEL");
    string memory name = vm.envString("POD_NAME");

    vm.startBroadcast();

    address regAddr = vm.envOr("SELF_REGISTRY_ADDR", address(0));
    LeasePodRegistry registry = regAddr == address(0)
      ? new LeasePodRegistry(hub)
      : LeasePodRegistry(regAddr);

    HarvestGuard guard = new HarvestGuard(world, hub, keeper);
    RoomPod pod = new RoomPod(world, hub, node, label, uint32(vm.envOr("PAY_ITEM", uint256(1))));
    pod.initialize(address(guard), name); // THE GUARD IS THE OPERATOR
    guard.setPod(address(pod));
    registry.addPod(address(pod));

    vm.stopBroadcast();

    console.log("SelfFarmRegistry:", address(registry));
    console.log("HarvestGuard:", address(guard));
    console.log("RoomPod:", address(pod));
    console.log("  node:", node);
    console.log("  accID:", pod.accID());
    console.log("  keeper:", keeper);
  }
}
