// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {ENSResolverAdapter} from "../../src/adapters/ENSResolverAdapter.sol";
import {LegacyVault} from "../../src/LegacyVault.sol";
import {LegacyVaultFactory} from "../../src/LegacyVaultFactory.sol";
import {WorldIDVerifierAdapter} from "../../src/adapters/WorldIDVerifierAdapter.sol";
import {MockWorldID} from "../mocks/MockWorldID.sol";
import {ENS} from "ens-contracts/registry/ENS.sol";

contract ENSForkTest is Test {
    // Canonical ENS Registry on Ethereum Mainnet & Sepolia
    address constant ENS_REGISTRY = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;

    // Real, canonical unwrapped ENS name on Ethereum Mainnet: "vitalik.eth"
    // namehash("vitalik.eth") = 0xee6c4522aab0003e8d14cd40a6af439055fd2577951148c14b6cea9a53475835
    bytes32 constant VITALIK_NODE = 0xee6c4522aab0003e8d14cd40a6af439055fd2577951148c14b6cea9a53475835;

    ENS public registry;
    LegacyVaultFactory public factory;
    WorldIDVerifierAdapter public verifier;
    LegacyVault public vault;
    ENSResolverAdapter public adapter;

    address realOwner;
    address heir = address(0xBEEF);

    uint256 constant CHECK_IN_INTERVAL = 30 days;
    uint256 constant GRACE_PERIOD = 7 days;
    uint256 constant CONTESTABLE_WINDOW = 3 days;

    bool forkActive;

    function setUp() public {
        string memory rpcUrl = vm.envOr("ETH_RPC_URL", string("https://ethereum-rpc.publicnode.com"));

        try vm.createSelectFork(rpcUrl) {
            forkActive = true;
        } catch {
            try vm.createSelectFork("https://eth.merkle.io") {
                forkActive = true;
            } catch {
                console.log("Warning: No RPC available for fork test. Skipping.");
                forkActive = false;
                return;
            }
        }

        registry = ENS(ENS_REGISTRY);

        // Read the real live owner directly from the canonical ENS Registry (no vm.store!)
        realOwner = registry.owner(VITALIK_NODE);
        require(realOwner != address(0), "Real ENS owner must not be zero");

        // Fund realOwner with ETH for gas on the fork
        vm.deal(realOwner, 10 ether);

        // Deploy protocol contracts on the fork
        MockWorldID mockWorldId = new MockWorldID();
        verifier = new WorldIDVerifierAdapter(mockWorldId, 1, 12345);

        LegacyVault implementation = new LegacyVault();
        factory = new LegacyVaultFactory(address(implementation));

        // Impersonate the real ENS owner to create their vault clone
        vm.prank(realOwner);
        vault = LegacyVault(factory.createVault(verifier, CHECK_IN_INTERVAL, GRACE_PERIOD, CONTESTABLE_WINDOW));

        // World ID registration
        uint256 dummyRoot = 1;
        uint256 dummyNullifier = 42;
        uint256[8] memory dummyProof = [uint256(0), 0, 0, 0, 0, 0, 0, 0];

        vm.prank(realOwner);
        vault.registerLiveness(abi.encode(dummyRoot, dummyNullifier, dummyProof));

        // Deploy ENSResolverAdapter pointing to the real ENS Registry and the real node
        adapter = new ENSResolverAdapter(ENS_REGISTRY, VITALIK_NODE, address(vault));

        // In the real ENS Registry, an operator calling setOwner on behalf of a user
        // requires operator approval (registry.isApprovedForAll(owner, operator))
        vm.prank(realOwner);
        registry.setApprovalForAll(address(adapter), true);
    }

    function test_fork_RealENSRegistryConfiguration() public view {
        if (!forkActive) return;

        assertTrue(ENS_REGISTRY.code.length > 0);
        assertEq(registry.owner(VITALIK_NODE), realOwner);
        assertTrue(adapter.checkOwnership(realOwner));
        assertTrue(registry.isApprovedForAll(realOwner, address(adapter)));
    }

    function test_fork_RealENSRegistrySuccessionTransfer() public {
        if (!forkActive) return;

        // 1. Real owner adds heir and assigns the real ENS domain
        bytes32 assetId = keccak256(abi.encodePacked("ENS", VITALIK_NODE));

        vm.startPrank(realOwner);
        vault.addHeir(heir);
        vault.assignAsset(assetId, heir, adapter);
        vm.stopPrank();

        // 2. Fast forward time past checkInInterval + gracePeriod -> turns Red
        vm.warp(block.timestamp + CHECK_IN_INTERVAL + GRACE_PERIOD);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Red));

        // 3. Heir initiates claim
        vm.prank(heir);
        vault.initiateClaim();
        assertEq(uint256(vault.claimStatus(heir)), uint256(LegacyVault.ClaimStatus.Contestable));

        // 4. Contestable window elapses
        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir);
        vault.finalizeClaim();
        assertEq(uint256(vault.claimStatus(heir)), uint256(LegacyVault.ClaimStatus.Claimed));

        // Before execution: real owner is still owner on the real ENS registry
        assertEq(registry.owner(VITALIK_NODE), realOwner);

        // 5. Heir executes claim -> calls ENSResolverAdapter -> calls real ENSRegistry.setOwner()
        vm.prank(heir);
        vault.executeClaim(assetId);

        // 6. Verify ownership on the real ENS Registry is now transferred to heir!
        assertEq(registry.owner(VITALIK_NODE), heir);
        assertTrue(adapter.checkOwnership(heir));
        assertFalse(adapter.checkOwnership(realOwner));

        // Verify allocation is marked executed
        (,,,, bool executed) = vault.allocations(assetId);
        assertTrue(executed);
    }
}
