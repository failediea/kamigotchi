// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity >=0.8.28;

import "forge-std/Test.sol";
import { PoolDirectory } from "vault/PoolDirectory.sol";

contract PoolDirectoryTest is Test {
  PoolDirectory dir;
  address stranger = address(0xBEEF);

  function setUp() public {
    dir = new PoolDirectory();
  }

  function testAddRemoveAndOrdering() public {
    dir.add(address(0x1), address(0x11), address(0), "MUSU pool");
    dir.add(address(0x2), address(0x22), address(0x33), "VIPP pool");
    dir.add(address(0x3), address(0x44), address(0), "whale pool");
    assertEq(dir.count(), 3);

    dir.remove(address(0x2)); // swap-pop: last entry moves into slot 1
    PoolDirectory.Pool[] memory all = dir.all();
    assertEq(all.length, 2);
    assertEq(all[0].hub, address(0x1));
    assertEq(all[1].hub, address(0x3));

    // removed hub can be re-listed; double-list cannot
    dir.add(address(0x2), address(0x22), address(0), "VIPP pool");
    vm.expectRevert("PD: listed");
    dir.add(address(0x2), address(0x22), address(0), "dup");
  }

  function testOnlyOwnerCurates() public {
    vm.prank(stranger);
    vm.expectRevert("PD: not owner");
    dir.add(address(0x1), address(0x11), address(0), "x");

    dir.add(address(0x1), address(0x11), address(0), "x");
    vm.prank(stranger);
    vm.expectRevert("PD: not owner");
    dir.remove(address(0x1));
  }

  function testOwnerHandOff() public {
    dir.setOwner(stranger);
    vm.expectRevert("PD: not owner");
    dir.add(address(0x1), address(0x11), address(0), "x");
    vm.prank(stranger);
    dir.add(address(0x1), address(0x11), address(0), "x");
    assertEq(dir.count(), 1);
  }
}
