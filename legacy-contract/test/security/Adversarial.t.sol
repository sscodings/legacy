// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {LegacyVault} from "../../src/LegacyVault.sol";
import {LegacyVaultFactory} from "../../src/LegacyVaultFactory.sol";
import {WorldIDVerifierAdapter} from "../../src/adapters/WorldIDVerifierAdapter.sol";
import {IVaultExecutor} from "../../src/interfaces/IVaultExecutor.sol";
import {MockWorldID} from "../mocks/MockWorldID.sol";
import {MockVaultExecutor} from "../mocks/MockVaultExecutor.sol";
import {MaliciousReentrantExecutor, ReentrancyTarget} from "../mocks/MaliciousReentrantExecutor.sol";
import {MaliciousHeir} from "../mocks/MaliciousHeir.sol";
import {NotifyingVaultExecutor} from "../mocks/NotifyingVaultExecutor.sol";

contract AdversarialTest is Test {
    LegacyVault public vault;
    LegacyVaultFactory public factory;
    WorldIDVerifierAdapter public verifierAdapter;
    MockWorldID public mockWorldId;
    MockVaultExecutor public mockExecutor;

    address owner = address(0xA11CE);
    address heir1 = address(0xBEEF1);
    address heir2 = address(0xBEEF2);
    address attacker = address(0xBAD);

    bytes32 constant ASSET_1 = keccak256("ASSET_1");
    bytes32 constant ASSET_2 = keccak256("ASSET_2");

    uint256 constant CHECK_IN_INTERVAL = 30 days;
    uint256 constant GRACE_PERIOD = 7 days;
    uint256 constant CONTESTABLE_WINDOW = 3 days;

    uint256 constant DUMMY_ROOT = 1;
    uint256 constant DUMMY_NULLIFIER = 42;
    uint256[8] DUMMY_PROOF = [uint256(0), 0, 0, 0, 0, 0, 0, 0];

    function setUp() public {
        mockWorldId = new MockWorldID();
        mockExecutor = new MockVaultExecutor();
        verifierAdapter = new WorldIDVerifierAdapter(mockWorldId, 1, 12345);

        LegacyVault implementation = new LegacyVault();
        factory = new LegacyVaultFactory(address(implementation));

        vm.prank(owner);
        vault = LegacyVault(factory.createVault(verifierAdapter, CHECK_IN_INTERVAL, GRACE_PERIOD, CONTESTABLE_WINDOW));

        vm.prank(owner);
        vault.registerLiveness(abi.encode(DUMMY_ROOT, DUMMY_NULLIFIER, DUMMY_PROOF));

        vm.prank(owner);
        vault.addHeir(heir1);

        vm.prank(owner);
        vault.addHeir(heir2);

        vm.prank(owner);
        vault.assignAsset(ASSET_1, heir1, mockExecutor);

        vm.prank(owner);
        vault.assignAsset(ASSET_2, heir2, mockExecutor);
    }

    function _checkIn() internal {
        vm.prank(owner);
        vault.checkIn(abi.encode(DUMMY_ROOT, DUMMY_NULLIFIER, DUMMY_PROOF));
    }

    function _warpToRed() internal {
        vm.warp(block.timestamp + CHECK_IN_INTERVAL + GRACE_PERIOD);
    }

    // =========================================================================
    // 1. Boundary Precision Tests (Exact Second Edge Cases)
    // =========================================================================

    function test_Boundary_GreenLastSecond_AllMutationsAllowed() public {
        // block.timestamp is at lastCheckIn + checkInInterval - 1 (Green)
        vm.warp(vault.lastCheckIn() + CHECK_IN_INTERVAL - 1);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Green));

        address tempHeir = address(0x999);
        bytes32 tempAsset = keccak256("TEMP");

        vm.startPrank(owner);
        vault.addHeir(tempHeir);
        vault.assignAsset(tempAsset, tempHeir, mockExecutor);
        vault.removeAsset(tempAsset);
        vault.removeHeir(tempHeir);
        vault.updateParameters(45 days, 10 days, 4 days);
        vm.stopPrank();

        assertEq(vault.checkInInterval(), 45 days);
    }

    function test_Boundary_AmberFirstSecond_AllMutationsLocked() public {
        // block.timestamp is at lastCheckIn + checkInInterval (Amber)
        vm.warp(vault.lastCheckIn() + CHECK_IN_INTERVAL);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Amber));

        address tempHeir = address(0x999);
        bytes32 tempAsset = keccak256("TEMP");

        vm.startPrank(owner);
        vm.expectRevert(LegacyVault.HeirChangesLocked.selector);
        vault.addHeir(tempHeir);

        vm.expectRevert(LegacyVault.HeirChangesLocked.selector);
        vault.removeHeir(heir1);

        vm.expectRevert(LegacyVault.HeirChangesLocked.selector);
        vault.assignAsset(tempAsset, heir1, mockExecutor);

        vm.expectRevert(LegacyVault.HeirChangesLocked.selector);
        vault.removeAsset(ASSET_1);

        vm.expectRevert(LegacyVault.ParametersLockedWhileNotGreen.selector);
        vault.updateParameters(45 days, 10 days, 4 days);
        vm.stopPrank();
    }

    function test_Boundary_AmberFirstSecond_CheckInResetsGreen() public {
        vm.warp(vault.lastCheckIn() + CHECK_IN_INTERVAL);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Amber));

        _checkIn();
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Green));
    }

    function test_Boundary_RedFirstSecond_InitiateClaimAllowed() public {
        // Exactly at lastCheckIn + checkInInterval + gracePeriod -> Red
        vm.warp(vault.lastCheckIn() + CHECK_IN_INTERVAL + GRACE_PERIOD);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Red));

        vm.prank(heir1);
        vault.initiateClaim();
        assertEq(uint256(vault.claimStatus(heir1)), uint256(LegacyVault.ClaimStatus.Contestable));
    }

    function test_Boundary_AmberLastSecond_InitiateClaimRejected() public {
        // Exactly 1 second before Red -> Amber
        vm.warp(vault.lastCheckIn() + CHECK_IN_INTERVAL + GRACE_PERIOD - 1);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Amber));

        vm.prank(heir1);
        vm.expectRevert(LegacyVault.VaultNotRed.selector);
        vault.initiateClaim();
    }

    function test_Boundary_ContestableWindowPrecision_ExactSecond() public {
        _warpToRed();
        uint256 claimTime = block.timestamp;

        vm.prank(heir1);
        vault.initiateClaim();

        // 1 second before window ends: must revert
        vm.warp(claimTime + CONTESTABLE_WINDOW - 1);
        vm.prank(heir1);
        vm.expectRevert(LegacyVault.ContestableWindowNotElapsed.selector);
        vault.finalizeClaim();

        // Exactly at window expiry: must succeed
        vm.warp(claimTime + CONTESTABLE_WINDOW);
        vm.prank(heir1);
        vault.finalizeClaim();

        assertEq(uint256(vault.claimStatus(heir1)), uint256(LegacyVault.ClaimStatus.Claimed));
    }

    function test_Boundary_SameBlockCheckInInvalidatesClaim() public {
        _warpToRed();
        uint256 redTimestamp = block.timestamp;

        // Heir initiates claim at timestamp T
        vm.prank(heir1);
        vault.initiateClaim();
        assertEq(vault.claimInitiatedAt(heir1), redTimestamp);

        // Owner checks in at the exact same timestamp T
        _checkIn();
        assertEq(vault.lastCheckIn(), redTimestamp);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Green));

        // Vault eventually goes Red again in the future
        _warpToRed();
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Red));

        // Contestable window from initial initiation has passed, but claim was invalidated in the same block/second
        vm.prank(heir1);
        vm.expectRevert(LegacyVault.ClaimNotContestable.selector);
        vault.finalizeClaim();
    }

    // =========================================================================
    // 2. Multi-Cycle Stale Claim & Stress Testing
    // =========================================================================

    function test_Adversarial_MultipleAlternatingClaimInvalidationCycles() public {
        // Cycle 1: Red -> Claim -> Owner CheckIn
        _warpToRed();
        vm.prank(heir1);
        vault.initiateClaim();
        _checkIn();

        // Cycle 2: Red -> Stale finalize fails -> Re-initiate -> Owner CheckIn
        _warpToRed();
        vm.prank(heir1);
        vm.expectRevert(LegacyVault.ClaimNotContestable.selector);
        vault.finalizeClaim();

        vm.prank(heir1);
        vault.initiateClaim();
        _checkIn();

        // Cycle 3: Red -> Stale finalize fails -> Re-initiate -> Window elapses -> Finalize & Execute
        _warpToRed();
        vm.prank(heir1);
        vm.expectRevert(LegacyVault.ClaimNotContestable.selector);
        vault.finalizeClaim();

        vm.prank(heir1);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir1);
        vault.finalizeClaim();
        assertEq(uint256(vault.claimStatus(heir1)), uint256(LegacyVault.ClaimStatus.Claimed));

        vm.prank(heir1);
        vault.executeClaim(ASSET_1);
        assertEq(mockExecutor.callCount(), 1);
    }

    function test_Adversarial_MultiHeirStaleClaimAsymmetry() public {
        _warpToRed();

        // Both heirs initiate claims
        vm.prank(heir1);
        vault.initiateClaim();
        vm.prank(heir2);
        vault.initiateClaim();

        // Owner invalidates both with a check-in
        _checkIn();

        // Vault goes Red again
        _warpToRed();

        // Heir 1 re-initiates; Heir 2 does not
        vm.prank(heir1);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);

        // Heir 1 finalizes successfully
        vm.prank(heir1);
        vault.finalizeClaim();

        // Heir 2 attempts finalize without re-initiating: reverts
        vm.prank(heir2);
        vm.expectRevert(LegacyVault.ClaimNotContestable.selector);
        vault.finalizeClaim();

        // Heir 2 attempts executeClaim: reverts ClaimNotFinalized
        vm.prank(heir2);
        vm.expectRevert(LegacyVault.ClaimNotFinalized.selector);
        vault.executeClaim(ASSET_2);

        // Now Heir 2 re-initiates
        vm.prank(heir2);
        vault.initiateClaim();

        // Heir 2 waits window and finalizes
        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir2);
        vault.finalizeClaim();

        // Heir 2 executes claim successfully
        vm.prank(heir2);
        vault.executeClaim(ASSET_2);
        assertEq(mockExecutor.callCount(), 1);
    }

    // =========================================================================
    // 3. Reentrancy Protection Tests
    // =========================================================================

    function test_Reentrancy_MaliciousExecutorCannotReenterExecuteSameAsset() public {
        MaliciousReentrantExecutor evilExecutor = new MaliciousReentrantExecutor(vault);

        bytes32 evilAsset = keccak256("EVIL_ASSET");
        vm.prank(owner);
        vault.assignAsset(evilAsset, heir1, evilExecutor);

        evilExecutor.setAttack(ReentrancyTarget.ExecuteSameAsset, evilAsset, bytes32(0), heir1);

        _warpToRed();
        vm.prank(heir1);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir1);
        vault.finalizeClaim();

        // Heir calls executeClaim on evilAsset.
        // evilExecutor attempts to reenter vault.executeClaim(evilAsset).
        vm.prank(heir1);
        vault.executeClaim(evilAsset);

        assertTrue(evilExecutor.attackAttempted());
        assertFalse(evilExecutor.attackSucceeded());
        // Verify the caught revert selector was ReentrancyGuardReentrantCall
        bytes4 caughtSelector = bytes4(evilExecutor.revertReason());
        assertEq(caughtSelector, ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
    }

    function test_Reentrancy_MaliciousExecutorCannotReenterExecuteOtherAsset() public {
        MaliciousReentrantExecutor evilExecutor = new MaliciousReentrantExecutor(vault);

        bytes32 evilAsset = keccak256("EVIL_ASSET");
        vm.prank(owner);
        vault.assignAsset(evilAsset, heir1, evilExecutor);

        // Attack attempts to execute ASSET_1 (which is assigned to heir1)
        evilExecutor.setAttack(ReentrancyTarget.ExecuteOtherAsset, evilAsset, ASSET_1, heir1);

        _warpToRed();
        vm.prank(heir1);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir1);
        vault.finalizeClaim();

        vm.prank(heir1);
        vault.executeClaim(evilAsset);

        assertTrue(evilExecutor.attackAttempted());
        assertFalse(evilExecutor.attackSucceeded());
        // Reentering executeClaim is blocked by nonReentrant
        bytes4 caughtSelector = bytes4(evilExecutor.revertReason());
        assertEq(caughtSelector, ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
    }

    function test_Reentrancy_MaliciousExecutorCannotReenterFinalizeClaim() public {
        MaliciousReentrantExecutor evilExecutor = new MaliciousReentrantExecutor(vault);

        bytes32 evilAsset = keccak256("EVIL_ASSET");
        vm.prank(owner);
        vault.assignAsset(evilAsset, heir1, evilExecutor);

        evilExecutor.setAttack(ReentrancyTarget.FinalizeClaim, evilAsset, bytes32(0), heir1);

        _warpToRed();
        vm.prank(heir1);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir1);
        vault.finalizeClaim();

        vm.prank(heir1);
        vault.executeClaim(evilAsset);

        assertTrue(evilExecutor.attackAttempted());
        assertFalse(evilExecutor.attackSucceeded());
        bytes4 caughtSelector = bytes4(evilExecutor.revertReason());
        assertEq(caughtSelector, LegacyVault.HeirNotRegistered.selector);
    }

    function test_Reentrancy_MaliciousExecutorCannotReenterInitiateClaim() public {
        MaliciousReentrantExecutor evilExecutor = new MaliciousReentrantExecutor(vault);

        bytes32 evilAsset = keccak256("EVIL_ASSET");
        vm.prank(owner);
        vault.assignAsset(evilAsset, heir1, evilExecutor);

        evilExecutor.setAttack(ReentrancyTarget.InitiateClaim, evilAsset, bytes32(0), heir1);

        _warpToRed();
        vm.prank(heir1);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir1);
        vault.finalizeClaim();

        vm.prank(heir1);
        vault.executeClaim(evilAsset);

        assertTrue(evilExecutor.attackAttempted());
        assertFalse(evilExecutor.attackSucceeded());
        bytes4 caughtSelector = bytes4(evilExecutor.revertReason());
        assertEq(caughtSelector, LegacyVault.HeirNotRegistered.selector);
    }

    function test_Reentrancy_MaliciousExecutorCannotReenterCheckIn() public {
        MaliciousReentrantExecutor evilExecutor = new MaliciousReentrantExecutor(vault);

        bytes32 evilAsset = keccak256("EVIL_ASSET");
        vm.prank(owner);
        vault.assignAsset(evilAsset, heir1, evilExecutor);

        evilExecutor.setAttack(ReentrancyTarget.CheckIn, evilAsset, bytes32(0), heir1);

        _warpToRed();
        vm.prank(heir1);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir1);
        vault.finalizeClaim();

        vm.prank(heir1);
        vault.executeClaim(evilAsset);

        assertTrue(evilExecutor.attackAttempted());
        assertFalse(evilExecutor.attackSucceeded());
        bytes4 caughtSelector = bytes4(evilExecutor.revertReason());
        assertEq(caughtSelector, LegacyVault.NotOwner.selector);
    }

    function test_Reentrancy_MaliciousExecutorCannotReenterAddHeir() public {
        MaliciousReentrantExecutor evilExecutor = new MaliciousReentrantExecutor(vault);

        bytes32 evilAsset = keccak256("EVIL_ASSET");
        vm.prank(owner);
        vault.assignAsset(evilAsset, heir1, evilExecutor);

        evilExecutor.setAttack(ReentrancyTarget.AddHeir, evilAsset, bytes32(0), heir1);

        _warpToRed();
        vm.prank(heir1);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir1);
        vault.finalizeClaim();

        vm.prank(heir1);
        vault.executeClaim(evilAsset);

        assertTrue(evilExecutor.attackAttempted());
        assertFalse(evilExecutor.attackSucceeded());
        bytes4 caughtSelector = bytes4(evilExecutor.revertReason());
        assertEq(caughtSelector, LegacyVault.NotOwner.selector);
    }

    function test_Reentrancy_MaliciousExecutorCannotReenterAssignAsset() public {
        MaliciousReentrantExecutor evilExecutor = new MaliciousReentrantExecutor(vault);

        bytes32 evilAsset = keccak256("EVIL_ASSET");
        vm.prank(owner);
        vault.assignAsset(evilAsset, heir1, evilExecutor);

        evilExecutor.setAttack(ReentrancyTarget.AssignAsset, evilAsset, bytes32(0), heir1);

        _warpToRed();
        vm.prank(heir1);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir1);
        vault.finalizeClaim();

        vm.prank(heir1);
        vault.executeClaim(evilAsset);

        assertTrue(evilExecutor.attackAttempted());
        assertFalse(evilExecutor.attackSucceeded());
        bytes4 caughtSelector = bytes4(evilExecutor.revertReason());
        assertEq(caughtSelector, LegacyVault.NotOwner.selector);
    }

    function test_Reentrancy_MaliciousHeirCallbackCannotReenterExecuteClaim() public {
        MaliciousHeir evilHeir = new MaliciousHeir(vault);
        NotifyingVaultExecutor notifyingExecutor = new NotifyingVaultExecutor();

        bytes32 contractAsset = keccak256("CONTRACT_ASSET");

        vm.startPrank(owner);
        vault.addHeir(address(evilHeir));
        vault.assignAsset(contractAsset, address(evilHeir), notifyingExecutor);
        vm.stopPrank();

        evilHeir.setConfig(contractAsset, true, false);

        _warpToRed();
        evilHeir.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        evilHeir.finalizeClaim();

        evilHeir.executeClaim(contractAsset);

        assertTrue(evilHeir.reenterAttempted());
        assertFalse(evilHeir.reenterSucceeded());
        bytes4 caughtSelector = bytes4(evilHeir.revertReason());
        assertEq(caughtSelector, ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
    }

    function test_Reentrancy_MaliciousHeirCallbackCannotReenterFinalizeClaim() public {
        MaliciousHeir evilHeir = new MaliciousHeir(vault);
        NotifyingVaultExecutor notifyingExecutor = new NotifyingVaultExecutor();

        bytes32 contractAsset = keccak256("CONTRACT_ASSET");

        vm.startPrank(owner);
        vault.addHeir(address(evilHeir));
        vault.assignAsset(contractAsset, address(evilHeir), notifyingExecutor);
        vm.stopPrank();

        evilHeir.setConfig(contractAsset, false, true);

        _warpToRed();
        evilHeir.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        evilHeir.finalizeClaim();

        evilHeir.executeClaim(contractAsset);

        assertTrue(evilHeir.reenterAttempted());
        assertFalse(evilHeir.reenterSucceeded());
        bytes4 caughtSelector = bytes4(evilHeir.revertReason());
        assertEq(caughtSelector, LegacyVault.ClaimNotContestable.selector);
    }

    // =========================================================================
    // 4. Post-Finalization Invalidation & Owner Revocation
    // =========================================================================

    function test_Adversarial_OwnerCheckInAfterFinalizationDoesNotBreakExecutionIfUnmodified() public {
        _warpToRed();
        vm.prank(heir1);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir1);
        vault.finalizeClaim();

        // Owner returns and checks in
        _checkIn();
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Green));

        // If owner did not remove the heir or asset, heir can still execute their finalized claim
        vm.prank(heir1);
        vault.executeClaim(ASSET_1);
        assertEq(mockExecutor.callCount(), 1);
    }

    function test_Adversarial_OwnerRevokesHeirAfterCheckInPreventsExecution() public {
        _warpToRed();
        vm.prank(heir1);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir1);
        vault.finalizeClaim();

        // Owner returns and checks in (now Green)
        _checkIn();

        // Owner removes heir
        vm.prank(owner);
        vault.removeHeir(heir1);

        // Finalized heir attempts executeClaim: reverts HeirNotRegistered
        vm.prank(heir1);
        vm.expectRevert(LegacyVault.HeirNotRegistered.selector);
        vault.executeClaim(ASSET_1);
    }

    function test_Adversarial_OwnerRevokesAssetAfterCheckInPreventsExecution() public {
        _warpToRed();
        vm.prank(heir1);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir1);
        vault.finalizeClaim();

        // Owner returns and checks in (now Green)
        _checkIn();

        // Owner removes asset
        vm.prank(owner);
        vault.removeAsset(ASSET_1);

        // Finalized heir attempts executeClaim: reverts AssetNotAssigned
        vm.prank(heir1);
        vm.expectRevert(LegacyVault.AssetNotAssigned.selector);
        vault.executeClaim(ASSET_1);
    }

    function test_Adversarial_OwnerCannotRevokeHeirWhileRedWithoutCheckIn() public {
        _warpToRed();
        vm.prank(heir1);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir1);
        vault.finalizeClaim();

        // Owner attempts to remove heir while vault is Red
        vm.prank(owner);
        vm.expectRevert(LegacyVault.HeirChangesLocked.selector);
        vault.removeHeir(heir1);
    }

    // ---------------------------------------------------------------------
    // Liveness binding cannot be hijacked through the shared verifier
    // ---------------------------------------------------------------------

    /// @notice Regression: the World ID adapter used to take the vault address as a
    ///         parameter with no access control. One adapter serves every vault, so
    ///         anyone holding a World ID could bind their own nullifier to a vault
    ///         whose owner had not registered yet. The owner's registration then
    ///         reverted forever, every check-in failed — including the one that
    ///         contests a claim — and the vault drifted to Red with the owner alive.
    function test_AttackerCannotBindNullifierToAnotherOwnersVault() public {
        vm.prank(owner);
        LegacyVault fresh =
            LegacyVault(factory.createVault(verifierAdapter, CHECK_IN_INTERVAL, GRACE_PERIOD, CONTESTABLE_WINDOW));

        // The attacker races the owner straight to the shared adapter.
        uint256 attackerNullifier = 666;
        vm.prank(attacker);
        verifierAdapter.registerCredential(owner, bytes32(0), abi.encode(DUMMY_ROOT, attackerNullifier, DUMMY_PROOF));

        // The binding can only ever land on the caller's own address...
        assertEq(verifierAdapter.vaultNullifier(attacker), attackerNullifier);
        assertEq(verifierAdapter.vaultNullifier(address(fresh)), 0);

        // ...so the real owner registers and checks in as normal.
        vm.prank(owner);
        fresh.registerLiveness(abi.encode(DUMMY_ROOT, DUMMY_NULLIFIER, DUMMY_PROOF));
        assertEq(verifierAdapter.vaultNullifier(address(fresh)), DUMMY_NULLIFIER);

        vm.warp(block.timestamp + 1 days);
        vm.prank(owner);
        fresh.checkIn(abi.encode(DUMMY_ROOT, DUMMY_NULLIFIER, DUMMY_PROOF));
        assertEq(fresh.lastCheckIn(), block.timestamp);
    }

    /// @notice Zero is the adapter's "unregistered" sentinel and must never become a binding.
    function test_RevertWhen_RegisteringZeroNullifier() public {
        vm.prank(owner);
        LegacyVault fresh =
            LegacyVault(factory.createVault(verifierAdapter, CHECK_IN_INTERVAL, GRACE_PERIOD, CONTESTABLE_WINDOW));

        vm.prank(owner);
        vm.expectRevert(WorldIDVerifierAdapter.InvalidNullifier.selector);
        fresh.registerLiveness(abi.encode(DUMMY_ROOT, uint256(0), DUMMY_PROOF));
    }
}
