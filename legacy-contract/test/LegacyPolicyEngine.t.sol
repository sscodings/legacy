// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LegacyVault} from "../src/LegacyVault.sol";
import {LegacyVaultFactory} from "../src/LegacyVaultFactory.sol";
import {LegacyPolicyEngine} from "../src/LegacyPolicyEngine.sol";
import {PolicyERC20Adapter} from "../src/adapters/PolicyERC20Adapter.sol";
import {ILegacyPolicyEngine} from "../src/interfaces/ILegacyPolicyEngine.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockWorldID} from "./mocks/MockWorldID.sol";
import {WorldIDVerifierAdapter} from "../src/adapters/WorldIDVerifierAdapter.sol";

contract LegacyPolicyEngineTest is Test {
    LegacyVault public vault;
    LegacyVaultFactory public factory;
    LegacyPolicyEngine public policyEngine;
    WorldIDVerifierAdapter public verifier;
    MockWorldID public worldId;
    MockERC20 public token;

    address public owner = address(0xAA1);
    address public heirAlice = address(0xBB1);
    address public heirBob = address(0xBB2);
    address public heirCharlie = address(0xBB3);
    address public nonHeir = address(0xEE1);
    address public attacker = address(0xBAD);

    uint256 public constant CHECK_IN_INTERVAL = 30 days;
    uint256 public constant GRACE_PERIOD = 7 days;
    uint256 public constant CONTESTABLE_WINDOW = 2 days;

    function setUp() public {
        worldId = new MockWorldID();
        verifier = new WorldIDVerifierAdapter(worldId, 1, 12345);

        LegacyVault implementation = new LegacyVault();
        factory = new LegacyVaultFactory(address(implementation));

        vm.prank(owner);
        vault = LegacyVault(factory.createVault(verifier, CHECK_IN_INTERVAL, GRACE_PERIOD, CONTESTABLE_WINDOW));

        policyEngine = new LegacyPolicyEngine();

        token = new MockERC20();
        token.mint(owner, 1000 * 10 ** 18);

        // Register heirs on vault while Green
        vm.startPrank(owner);
        vault.addHeir(heirAlice);
        vault.addHeir(heirBob);
        vault.addHeir(heirCharlie);
        vm.stopPrank();
    }

    function _createSampleRules() internal view returns (ILegacyPolicyEngine.PolicyRule[] memory) {
        ILegacyPolicyEngine.PolicyRule[] memory rules = new ILegacyPolicyEngine.PolicyRule[](2);

        // Rule 0: Alice receives 500 USDC immediately (0 delay)
        rules[0] = ILegacyPolicyEngine.PolicyRule({
            beneficiary: heirAlice,
            assetId: keccak256("USDC-500-ALICE"),
            token: address(token),
            amount: 500 * 10 ** 6,
            percentageBps: 5000,
            releaseDelaySeconds: 0,
            fallbackBeneficiary: address(0)
        });

        // Rule 1: Bob receives 500 USDC after 90 days delay
        rules[1] = ILegacyPolicyEngine.PolicyRule({
            beneficiary: heirBob,
            assetId: keccak256("USDC-500-BOB"),
            token: address(token),
            amount: 500 * 10 ** 6,
            percentageBps: 5000,
            releaseDelaySeconds: 90 days,
            fallbackBeneficiary: heirCharlie
        });

        return rules;
    }

    // -------------------------------------------------------------------------
    // Policy Creation & Deterministic Hashing
    // -------------------------------------------------------------------------

    function test_DeterministicPolicyHash() public view {
        ILegacyPolicyEngine.PolicyRule[] memory rules = _createSampleRules();

        bytes32 hash1 = policyEngine.computePolicyHash(address(vault), 1, policyEngine.TRIGGER_SUCCESSION(), rules);
        bytes32 hash2 = policyEngine.computePolicyHash(address(vault), 1, policyEngine.TRIGGER_SUCCESSION(), rules);

        assertEq(hash1, hash2, "Policy hash must be strictly deterministic");
    }

    function test_HashDiffersOnModifiedRule() public view {
        ILegacyPolicyEngine.PolicyRule[] memory rules1 = _createSampleRules();
        ILegacyPolicyEngine.PolicyRule[] memory rules2 = _createSampleRules();

        // Alter delay on rule 1
        rules2[1].releaseDelaySeconds = 60 days;

        bytes32 hash1 = policyEngine.computePolicyHash(address(vault), 1, policyEngine.TRIGGER_SUCCESSION(), rules1);
        bytes32 hash2 = policyEngine.computePolicyHash(address(vault), 1, policyEngine.TRIGGER_SUCCESSION(), rules2);

        assertTrue(hash1 != hash2, "Different delay must produce different hash");
    }

    function test_HashDiffersOnDifferentVault() public view {
        ILegacyPolicyEngine.PolicyRule[] memory rules = _createSampleRules();

        address anotherVault = address(0x999);
        bytes32 hash1 = policyEngine.computePolicyHash(address(vault), 1, policyEngine.TRIGGER_SUCCESSION(), rules);
        bytes32 hash2 = policyEngine.computePolicyHash(anotherVault, 1, policyEngine.TRIGGER_SUCCESSION(), rules);

        assertTrue(hash1 != hash2, "Different vault must produce different hash (replay protection)");
    }

    function test_HashDiffersOnDifferentVersion() public view {
        ILegacyPolicyEngine.PolicyRule[] memory rules = _createSampleRules();

        bytes32 hash1 = policyEngine.computePolicyHash(address(vault), 1, policyEngine.TRIGGER_SUCCESSION(), rules);
        bytes32 hash2 = policyEngine.computePolicyHash(address(vault), 2, policyEngine.TRIGGER_SUCCESSION(), rules);

        assertTrue(hash1 != hash2, "Different version must produce different hash");
    }

    // -------------------------------------------------------------------------
    // Owner Authorization & Commitment
    // -------------------------------------------------------------------------

    function test_OwnerCanCommitValidPolicy() public {
        ILegacyPolicyEngine.PolicyRule[] memory rules = _createSampleRules();
        bytes32 policyHash = policyEngine.computePolicyHash(address(vault), 1, policyEngine.TRIGGER_SUCCESSION(), rules);

        vm.prank(owner);
        uint256 version = policyEngine.commitPolicy(address(vault), policyHash, rules);

        assertEq(version, 1);
        assertEq(policyEngine.latestVersion(address(vault)), 1);

        ILegacyPolicyEngine.PolicyCommitment memory commitment = policyEngine.getActivePolicy(address(vault));
        assertEq(commitment.version, 1);
        assertEq(commitment.policyHash, policyHash);
        assertEq(commitment.ruleCount, 2);
        assertTrue(commitment.exists);

        ILegacyPolicyEngine.PolicyRule memory r0 = policyEngine.getPolicyRule(address(vault), 1, 0);
        assertEq(r0.beneficiary, heirAlice);
        assertEq(r0.amount, 500 * 10 ** 6);
        assertEq(r0.releaseDelaySeconds, 0);

        ILegacyPolicyEngine.PolicyRule memory r1 = policyEngine.getPolicyRule(address(vault), 1, 1);
        assertEq(r1.beneficiary, heirBob);
        assertEq(r1.fallbackBeneficiary, heirCharlie);
        assertEq(r1.releaseDelaySeconds, 90 days);
    }

    function test_RevertWhen_NonOwnerCommitsPolicy() public {
        ILegacyPolicyEngine.PolicyRule[] memory rules = _createSampleRules();
        bytes32 policyHash = policyEngine.computePolicyHash(address(vault), 1, policyEngine.TRIGGER_SUCCESSION(), rules);

        vm.prank(attacker);
        vm.expectRevert(LegacyPolicyEngine.NotVaultOwner.selector);
        policyEngine.commitPolicy(address(vault), policyHash, rules);
    }

    function test_RevertWhen_VaultNotGreen() public {
        // Warp vault into Amber/Red
        vm.warp(block.timestamp + CHECK_IN_INTERVAL + 1);

        ILegacyPolicyEngine.PolicyRule[] memory rules = _createSampleRules();
        bytes32 policyHash = policyEngine.computePolicyHash(address(vault), 1, policyEngine.TRIGGER_SUCCESSION(), rules);

        vm.prank(owner);
        vm.expectRevert(LegacyPolicyEngine.VaultNotGreen.selector);
        policyEngine.commitPolicy(address(vault), policyHash, rules);
    }

    function test_RevertWhen_BeneficiaryNotRegisteredHeir() public {
        ILegacyPolicyEngine.PolicyRule[] memory rules = _createSampleRules();
        rules[0].beneficiary = nonHeir; // nonHeir is not registered on vault

        bytes32 policyHash = policyEngine.computePolicyHash(address(vault), 1, policyEngine.TRIGGER_SUCCESSION(), rules);

        vm.prank(owner);
        vm.expectRevert(LegacyPolicyEngine.BeneficiaryNotHeir.selector);
        policyEngine.commitPolicy(address(vault), policyHash, rules);
    }

    function test_RevertWhen_FallbackBeneficiaryNotRegisteredHeir() public {
        ILegacyPolicyEngine.PolicyRule[] memory rules = _createSampleRules();
        rules[1].fallbackBeneficiary = nonHeir; // nonHeir is not registered

        bytes32 policyHash = policyEngine.computePolicyHash(address(vault), 1, policyEngine.TRIGGER_SUCCESSION(), rules);

        vm.prank(owner);
        vm.expectRevert(LegacyPolicyEngine.FallbackBeneficiaryNotHeir.selector);
        policyEngine.commitPolicy(address(vault), policyHash, rules);
    }

    function test_RevertWhen_HashMismatch() public {
        ILegacyPolicyEngine.PolicyRule[] memory rules = _createSampleRules();
        bytes32 bogusHash = keccak256("BOGUS_HASH");

        vm.prank(owner);
        vm.expectRevert();
        policyEngine.commitPolicy(address(vault), bogusHash, rules);
    }

    // -------------------------------------------------------------------------
    // Policy Versioning
    // -------------------------------------------------------------------------

    function test_NewPolicySupersedesOldPolicy() public {
        ILegacyPolicyEngine.PolicyRule[] memory rulesV1 = _createSampleRules();
        bytes32 hashV1 = policyEngine.computePolicyHash(address(vault), 1, policyEngine.TRIGGER_SUCCESSION(), rulesV1);

        vm.prank(owner);
        policyEngine.commitPolicy(address(vault), hashV1, rulesV1);

        // Update rules for v2: 100% to Alice
        ILegacyPolicyEngine.PolicyRule[] memory rulesV2 = new ILegacyPolicyEngine.PolicyRule[](1);
        rulesV2[0] = ILegacyPolicyEngine.PolicyRule({
            beneficiary: heirAlice,
            assetId: keccak256("USDC-1000-ALICE"),
            token: address(token),
            amount: 1000 * 10 ** 6,
            percentageBps: 10000,
            releaseDelaySeconds: 0,
            fallbackBeneficiary: address(0)
        });

        bytes32 hashV2 = policyEngine.computePolicyHash(address(vault), 2, policyEngine.TRIGGER_SUCCESSION(), rulesV2);

        vm.prank(owner);
        uint256 v2 = policyEngine.commitPolicy(address(vault), hashV2, rulesV2);

        assertEq(v2, 2);
        assertEq(policyEngine.latestVersion(address(vault)), 2);

        ILegacyPolicyEngine.PolicyCommitment memory active = policyEngine.getActivePolicy(address(vault));
        assertEq(active.version, 2);
        assertEq(active.policyHash, hashV2);
        assertEq(active.ruleCount, 1);
    }

    // -------------------------------------------------------------------------
    // Release Timing & PolicyERC20Adapter Execution
    // -------------------------------------------------------------------------

    function test_PolicyERC20Adapter_ImmediateExecution() public {
        // Rule: Alice receives 500 USDC immediately (0 delay)
        PolicyERC20Adapter adapter = new PolicyERC20Adapter(
            address(token),
            500 * 10 ** 6,
            address(vault),
            0, // immediate
            heirAlice,
            address(0)
        );

        bytes32 assetId = keccak256("ALICE-IMMEDIATE");

        vm.startPrank(owner);
        token.approve(address(adapter), 500 * 10 ** 6);
        vault.assignAsset(assetId, heirAlice, adapter);
        vm.stopPrank();

        assertTrue(adapter.checkOwnership(owner));

        // Warp to Red status: CHECK_IN_INTERVAL + GRACE_PERIOD
        vm.warp(block.timestamp + CHECK_IN_INTERVAL + GRACE_PERIOD);

        // Alice initiates and finalizes claim
        vm.prank(heirAlice);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);

        vm.prank(heirAlice);
        vault.finalizeClaim();

        // Alice executes immediately
        vm.prank(heirAlice);
        vault.executeClaim(assetId);

        assertEq(token.balanceOf(heirAlice), 500 * 10 ** 6);
    }

    function test_PolicyERC20Adapter_DelayedExecutionEnforced() public {
        uint256 delay = 90 days;

        // Rule: Bob receives 500 USDC after 90 days delay
        PolicyERC20Adapter adapter = new PolicyERC20Adapter(
            address(token),
            500 * 10 ** 6,
            address(vault),
            delay,
            heirBob,
            heirCharlie
        );

        bytes32 assetId = keccak256("BOB-DELAYED-90D");

        vm.startPrank(owner);
        token.approve(address(adapter), 500 * 10 ** 6);
        vault.assignAsset(assetId, heirBob, adapter);
        vm.stopPrank();

        // Warp to Red
        vm.warp(block.timestamp + CHECK_IN_INTERVAL + GRACE_PERIOD);

        // Bob initiates and finalizes claim
        vm.prank(heirBob);
        vault.initiateClaim();

        uint256 claimInitTime = block.timestamp;
        vm.warp(claimInitTime + CONTESTABLE_WINDOW);

        vm.prank(heirBob);
        vault.finalizeClaim();

        // Attempting to execute claim at T+10 days (before 90 days delay) MUST REVERT on-chain
        vm.warp(claimInitTime + CONTESTABLE_WINDOW + 10 days);
        vm.prank(heirBob);
        vm.expectRevert();
        vault.executeClaim(assetId);

        // Exact boundary test: 1 second before release delay -> REVERTS
        vm.warp(claimInitTime + CONTESTABLE_WINDOW + delay - 1);
        vm.prank(heirBob);
        vm.expectRevert();
        vault.executeClaim(assetId);

        // Exactly at release time -> SUCCEEDS!
        vm.warp(claimInitTime + CONTESTABLE_WINDOW + delay);
        vm.prank(heirBob);
        vault.executeClaim(assetId);

        assertEq(token.balanceOf(heirBob), 500 * 10 ** 6);
    }

    function test_PolicyERC20Adapter_UnauthorizedClaimantReverts() public {
        PolicyERC20Adapter adapter = new PolicyERC20Adapter(
            address(token),
            500 * 10 ** 6,
            address(vault),
            0,
            heirAlice,
            address(0) // no fallback
        );

        bytes32 assetId = keccak256("ALICE-ONLY");

        vm.startPrank(owner);
        token.approve(address(adapter), 500 * 10 ** 6);
        vault.assignAsset(assetId, heirAlice, adapter);
        vm.stopPrank();

        // Direct call from non-vault reverts NotVault
        vm.prank(heirBob);
        vm.expectRevert(PolicyERC20Adapter.NotVault.selector);
        adapter.transferControl(owner, heirBob);
    }
}
