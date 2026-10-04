// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {ENSResolverAdapter, IENSRegistry} from "../src/adapters/ENSResolverAdapter.sol";
import {LegacyVault} from "../src/LegacyVault.sol";
import {LegacyVaultFactory} from "../src/LegacyVaultFactory.sol";
import {WorldIDVerifierAdapter} from "../src/adapters/WorldIDVerifierAdapter.sol";
import {MockENSRegistry} from "./mocks/MockENSRegistry.sol";
import {MockWorldID} from "./mocks/MockWorldID.sol";

contract ENSResolverAdapterTest is Test {
    MockENSRegistry public registry;
    ENSResolverAdapter public adapter;

    address owner = address(0xA11CE);
    address heir = address(0xBEEF);
    address attacker = address(0xBAD);
    address mockVault = address(0xCAFE);

    bytes32 constant ENS_NODE = keccak256(abi.encodePacked("myname.eth"));

    event ENSOwnershipTransferred(bytes32 indexed node, address indexed from, address indexed to);

    function setUp() public {
        registry = new MockENSRegistry();
        registry.setOwner(ENS_NODE, owner);

        adapter = new ENSResolverAdapter(address(registry), ENS_NODE, mockVault);
    }

    // -------------------------------------------------------------------------
    // Adapter Unit Tests
    // -------------------------------------------------------------------------

    function test_constructorStoresConfiguration() public view {
        assertEq(address(adapter.registry()), address(registry));
        assertEq(adapter.node(), ENS_NODE);
        assertEq(adapter.vault(), mockVault);
    }

    function test_revertWhen_ConstructorWithZeroAddress() public {
        vm.expectRevert(ENSResolverAdapter.InvalidAddress.selector);
        new ENSResolverAdapter(address(0), ENS_NODE, mockVault);

        vm.expectRevert(ENSResolverAdapter.InvalidAddress.selector);
        new ENSResolverAdapter(address(registry), ENS_NODE, address(0));
    }

    function test_revertWhen_ConstructorWithZeroNode() public {
        vm.expectRevert(ENSResolverAdapter.InvalidNode.selector);
        new ENSResolverAdapter(address(registry), bytes32(0), mockVault);
    }

    function test_checkOwnershipReturnsTrueForCurrentOwner() public view {
        assertTrue(adapter.checkOwnership(owner));
    }

    function test_checkOwnershipReturnsFalseForDifferentOwner() public view {
        assertFalse(adapter.checkOwnership(heir));
        assertFalse(adapter.checkOwnership(address(0)));
    }

    function test_onlyVaultCanTransferControl() public {
        vm.prank(attacker);
        vm.expectRevert(ENSResolverAdapter.NotVault.selector);
        adapter.transferControl(owner, heir);
    }

    function test_revertWhen_FromIsNotCurrentENSOwner() public {
        address wrongOwner = address(0x1234);

        vm.prank(mockVault);
        vm.expectRevert(ENSResolverAdapter.NotCurrentOwner.selector);
        adapter.transferControl(wrongOwner, heir);
    }

    function test_transferControlTransfersENSOwnership() public {
        vm.expectEmit(true, true, true, true);
        emit ENSOwnershipTransferred(ENS_NODE, owner, heir);

        vm.prank(mockVault);
        adapter.transferControl(owner, heir);

        assertEq(registry.owner(ENS_NODE), heir);
    }

    // -------------------------------------------------------------------------
    // End-to-End Succession Test: LegacyVault -> ENSResolverAdapter -> Registry
    // -------------------------------------------------------------------------

    function test_e2e_LegacyVaultTransfersENSOwnershipOnSuccession() public {
        // 1. Deploy protocol infrastructure
        MockWorldID mockWorldId = new MockWorldID();
        WorldIDVerifierAdapter verifier = new WorldIDVerifierAdapter(mockWorldId, 1, 12345);

        LegacyVault implementation = new LegacyVault();
        LegacyVaultFactory factory = new LegacyVaultFactory(address(implementation));

        uint256 checkInInterval = 30 days;
        uint256 gracePeriod = 7 days;
        uint256 contestableWindow = 3 days;

        // 2. Owner creates their vault clone
        vm.prank(owner);
        LegacyVault vault = LegacyVault(factory.createVault(verifier, checkInInterval, gracePeriod, contestableWindow));

        uint256 dummyRoot = 1;
        uint256 dummyNullifier = 42;
        uint256[8] memory dummyProof = [uint256(0), 0, 0, 0, 0, 0, 0, 0];

        vm.prank(owner);
        vault.registerLiveness(abi.encode(dummyRoot, dummyNullifier, dummyProof));

        // 3. Setup ENS domain and adapter pointing to the genuine vault
        bytes32 vitalikNode = keccak256(abi.encodePacked("vitalik.eth"));
        registry.setOwner(vitalikNode, owner);

        ENSResolverAdapter ensAdapter = new ENSResolverAdapter(address(registry), vitalikNode, address(vault));

        // 4. Owner adds heir and assigns ENS domain
        bytes32 assetId = keccak256(abi.encodePacked("ENS", vitalikNode));

        vm.startPrank(owner);
        vault.addHeir(heir);
        vault.assignAsset(assetId, heir, ensAdapter);
        vm.stopPrank();

        // Check ownership matches
        assertTrue(ensAdapter.checkOwnership(owner));

        // 5. Time warps past checkInInterval + gracePeriod -> Vault turns Red
        vm.warp(block.timestamp + checkInInterval + gracePeriod);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Red));

        // 6. Heir initiates claim
        vm.prank(heir);
        vault.initiateClaim();
        assertEq(uint256(vault.claimStatus(heir)), uint256(LegacyVault.ClaimStatus.Contestable));

        // 7. Contestable window elapses with no owner checkIn -> Heir finalizes
        vm.warp(block.timestamp + contestableWindow);
        vm.prank(heir);
        vault.finalizeClaim();
        assertEq(uint256(vault.claimStatus(heir)), uint256(LegacyVault.ClaimStatus.Claimed));

        // Before execution, registry owner is still the original owner
        assertEq(registry.owner(vitalikNode), owner);

        // 8. Heir executes claim on the ENS asset
        vm.prank(heir);
        vault.executeClaim(assetId);

        // 9. Verify ownership is transferred to the heir!
        assertEq(registry.owner(vitalikNode), heir);
        assertTrue(ensAdapter.checkOwnership(heir));

        (,,,, bool executed) = vault.allocations(assetId);
        assertTrue(executed);
    }
}
