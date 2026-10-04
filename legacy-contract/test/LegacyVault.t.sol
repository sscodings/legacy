// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LegacyVault} from "../src/LegacyVault.sol";
import {LegacyVaultFactory} from "../src/LegacyVaultFactory.sol";
import {WorldIDVerifierAdapter} from "../src/adapters/WorldIDVerifierAdapter.sol";
import {IVaultExecutor} from "../src/interfaces/IVaultExecutor.sol";
import {MockWorldID} from "./mocks/MockWorldID.sol";
import {MockVaultExecutor} from "./mocks/MockVaultExecutor.sol";

contract LegacyVaultTest is Test {
    LegacyVault public vault;
    LegacyVaultFactory public factory;
    WorldIDVerifierAdapter public verifierAdapter;
    MockWorldID public mockWorldId;
    MockVaultExecutor public mockExecutor;

    address owner = address(0xA11CE);
    address heir = address(0xBEEF);
    address otherHeir = address(0xCAFE);
    address nonHeir = address(0xDEAD);
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
        vault.addHeir(heir);

        vm.prank(owner);
        vault.addHeir(otherHeir);

        vm.prank(owner);
        vault.assignAsset(ASSET_1, heir, mockExecutor);
    }

    function _checkIn() internal {
        vm.prank(owner);
        vault.checkIn(abi.encode(DUMMY_ROOT, DUMMY_NULLIFIER, DUMMY_PROOF));
    }

    function _warpToRed() internal {
        vm.warp(block.timestamp + CHECK_IN_INTERVAL + GRACE_PERIOD);
    }

    // ---------------------------------------------------------------------
    // Layer 1: Vault-Wide Liveness State Machine
    // ---------------------------------------------------------------------

    function test_InitialStatusIsGreen() public view {
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Green));
    }

    function test_StatusStaysGreenJustBeforeInterval() public {
        vm.warp(block.timestamp + CHECK_IN_INTERVAL - 1);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Green));
    }

    function test_StatusFlipsToAmberAtInterval() public {
        vm.warp(block.timestamp + CHECK_IN_INTERVAL);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Amber));
    }

    function test_StatusStaysAmberDuringGracePeriod() public {
        vm.warp(block.timestamp + CHECK_IN_INTERVAL + GRACE_PERIOD - 1);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Amber));
    }

    function test_StatusFlipsToRedAfterGracePeriod() public {
        vm.warp(block.timestamp + CHECK_IN_INTERVAL + GRACE_PERIOD);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Red));
    }

    function test_StatusStaysRedIndefinitely() public {
        vm.warp(block.timestamp + CHECK_IN_INTERVAL + GRACE_PERIOD + 365 days);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Red));
    }

    function test_CheckInResetsToGreenFromAmber() public {
        vm.warp(block.timestamp + CHECK_IN_INTERVAL + 1);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Amber));

        _checkIn();

        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Green));
    }

    function test_CheckInResetsToGreenFromRed() public {
        vm.warp(block.timestamp + CHECK_IN_INTERVAL + GRACE_PERIOD + 1);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Red));

        _checkIn();

        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Green));
    }

    function test_RevertWhen_NonOwnerCallsCheckIn() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(LegacyVault.NotOwner.selector);
        vault.checkIn(abi.encode(DUMMY_ROOT, DUMMY_NULLIFIER, DUMMY_PROOF));
    }

    function test_UpdateParametersSucceedsWhileGreen() public {
        vm.prank(owner);
        vault.updateParameters(60 days, 14 days, 5 days);

        assertEq(vault.checkInInterval(), 60 days);
        assertEq(vault.gracePeriod(), 14 days);
        assertEq(vault.contestableWindow(), 5 days);
    }

    function test_RevertWhen_UpdateParametersCalledWhileAmber() public {
        vm.warp(block.timestamp + CHECK_IN_INTERVAL + 1);

        vm.prank(owner);
        vm.expectRevert(LegacyVault.ParametersLockedWhileNotGreen.selector);
        vault.updateParameters(60 days, 14 days, 5 days);
    }

    function test_RevertWhen_UpdateParametersCalledWhileRed() public {
        vm.warp(block.timestamp + CHECK_IN_INTERVAL + GRACE_PERIOD + 1);

        vm.prank(owner);
        vm.expectRevert(LegacyVault.ParametersLockedWhileNotGreen.selector);
        vault.updateParameters(60 days, 14 days, 5 days);
    }

    function test_RevertWhen_NonOwnerCallsUpdateParameters() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(LegacyVault.NotOwner.selector);
        vault.updateParameters(60 days, 14 days, 5 days);
    }

    function testFuzz_StatusNeverSkipsAmber(uint256 warpAmount) public {
        warpAmount = bound(warpAmount, CHECK_IN_INTERVAL, CHECK_IN_INTERVAL + GRACE_PERIOD - 1);
        vm.warp(block.timestamp + warpAmount);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Amber));
    }

    // ---------------------------------------------------------------------
    // World ID wiring tests
    // ---------------------------------------------------------------------

    function test_RevertWhen_CheckInBeforeLivenessRegistered() public {
        vm.prank(owner);
        LegacyVault freshVault =
            LegacyVault(factory.createVault(verifierAdapter, CHECK_IN_INTERVAL, GRACE_PERIOD, CONTESTABLE_WINDOW));

        vm.prank(owner);
        vm.expectRevert(LegacyVault.LivenessNotRegistered.selector);
        freshVault.checkIn(abi.encode(DUMMY_ROOT, DUMMY_NULLIFIER, DUMMY_PROOF));
    }

    function test_RevertWhen_RegisterLivenessCalledTwice() public {
        vm.prank(owner);
        vm.expectRevert(LegacyVault.LivenessAlreadyRegistered.selector);
        vault.registerLiveness(abi.encode(DUMMY_ROOT, DUMMY_NULLIFIER, DUMMY_PROOF));
    }

    function test_RevertWhen_CheckInWithWrongNullifier() public {
        vm.prank(owner);
        vm.expectRevert(WorldIDVerifierAdapter.NullifierMismatch.selector);
        vault.checkIn(abi.encode(DUMMY_ROOT, 999, DUMMY_PROOF));
    }

    function test_RevertWhen_WorldIDProofInvalid() public {
        mockWorldId.setShouldRevert(true);
        vm.prank(owner);
        vm.expectRevert("MockWorldID: forced revert");
        vault.checkIn(abi.encode(DUMMY_ROOT, DUMMY_NULLIFIER, DUMMY_PROOF));
    }

    function test_RevertWhen_CrossVaultProofReplayedOnDifferentVault() public {
        // Deploy a second vault clone for the same owner
        vm.prank(owner);
        LegacyVault vaultB =
            LegacyVault(factory.createVault(verifierAdapter, CHECK_IN_INTERVAL, GRACE_PERIOD, CONTESTABLE_WINDOW));

        // Signal hash is bound to (vault, owner)
        uint256 signalHashA = verifierAdapter.hashSignal(address(vault), owner);
        uint256 signalHashB = verifierAdapter.hashSignal(address(vaultB), owner);
        assertTrue(signalHashA != signalHashB);

        // Lock MockWorldID to expect Vault A's signal hash
        mockWorldId.setExpectedSignalHash(signalHashA);

        // Vault A checkIn succeeds because signalHash matches signalHashA
        vm.prank(owner);
        vault.checkIn(abi.encode(DUMMY_ROOT, DUMMY_NULLIFIER, DUMMY_PROOF));

        // Registering liveness on Vault B with the same proof parameters reverts because signal hash doesn't match
        vm.prank(owner);
        vm.expectRevert("MockWorldID: invalid signal hash");
        vaultB.registerLiveness(abi.encode(DUMMY_ROOT, DUMMY_NULLIFIER, DUMMY_PROOF));
    }

    function test_RevertWhen_InitializeWithSubMinimumParameters() public {
        uint256 subInterval = vault.MIN_CHECK_IN_INTERVAL() - 1;
        uint256 subWindow = vault.MIN_CONTESTABLE_WINDOW() - 1;

        vm.expectRevert(LegacyVault.IntervalTooShort.selector);
        factory.createVault(verifierAdapter, 0, GRACE_PERIOD, CONTESTABLE_WINDOW);

        vm.expectRevert(LegacyVault.IntervalTooShort.selector);
        factory.createVault(verifierAdapter, subInterval, GRACE_PERIOD, CONTESTABLE_WINDOW);

        vm.expectRevert(LegacyVault.ContestableWindowTooShort.selector);
        factory.createVault(verifierAdapter, CHECK_IN_INTERVAL, GRACE_PERIOD, 0);

        vm.expectRevert(LegacyVault.ContestableWindowTooShort.selector);
        factory.createVault(verifierAdapter, CHECK_IN_INTERVAL, GRACE_PERIOD, subWindow);
    }

    function test_RevertWhen_UpdateParametersWithSubMinimumParameters() public {
        uint256 subInterval = vault.MIN_CHECK_IN_INTERVAL() - 1;
        uint256 subWindow = vault.MIN_CONTESTABLE_WINDOW() - 1;

        vm.startPrank(owner);

        vm.expectRevert(LegacyVault.IntervalTooShort.selector);
        vault.updateParameters(0, GRACE_PERIOD, CONTESTABLE_WINDOW);

        vm.expectRevert(LegacyVault.IntervalTooShort.selector);
        vault.updateParameters(subInterval, GRACE_PERIOD, CONTESTABLE_WINDOW);

        vm.expectRevert(LegacyVault.ContestableWindowTooShort.selector);
        vault.updateParameters(CHECK_IN_INTERVAL, GRACE_PERIOD, 0);

        vm.expectRevert(LegacyVault.ContestableWindowTooShort.selector);
        vault.updateParameters(CHECK_IN_INTERVAL, GRACE_PERIOD, subWindow);

        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Heir Management Tests
    // ---------------------------------------------------------------------

    function test_ownerCanAddHeir() public {
        address newHeir = address(0x1234);
        vm.prank(owner);
        vault.addHeir(newHeir);

        assertTrue(vault.isHeir(newHeir));
        assertEq(vault.getHeirCount(), 3);
        address[] memory currentHeirs = vault.getHeirs();
        assertEq(currentHeirs.length, 3);
    }

    function test_duplicateHeirReverts() public {
        vm.startPrank(owner);
        vm.expectRevert(LegacyVault.HeirAlreadyRegistered.selector);
        vault.addHeir(heir);
        vm.stopPrank();
    }

    function test_nonOwnerCannotAddHeir() public {
        vm.prank(attacker);
        vm.expectRevert(LegacyVault.NotOwner.selector);
        vault.addHeir(address(0x1234));
    }

    function test_heirChangesLockedWhenAmber() public {
        vm.warp(block.timestamp + CHECK_IN_INTERVAL);
        vm.prank(owner);
        vm.expectRevert(LegacyVault.HeirChangesLocked.selector);
        vault.addHeir(address(0x1234));
    }

    function test_heirChangesLockedWhenRed() public {
        _warpToRed();
        vm.prank(owner);
        vm.expectRevert(LegacyVault.HeirChangesLocked.selector);
        vault.addHeir(address(0x1234));
    }

    function test_revertWhen_AddInvalidHeir() public {
        vm.startPrank(owner);
        vm.expectRevert(LegacyVault.InvalidHeir.selector);
        vault.addHeir(address(0));

        vm.expectRevert(LegacyVault.InvalidHeir.selector);
        vault.addHeir(owner);
        vm.stopPrank();
    }

    function test_ownerCanRemoveHeir() public {
        vm.prank(owner);
        vault.removeHeir(heir);

        assertFalse(vault.isHeir(heir));
        assertEq(vault.getHeirCount(), 1);
    }

    function test_revertWhen_RemoveNonRegisteredHeir() public {
        vm.prank(owner);
        vm.expectRevert(LegacyVault.HeirNotRegistered.selector);
        vault.removeHeir(nonHeir);
    }

    function test_nonHeirCannotInitiateClaim() public {
        _warpToRed();
        vm.prank(nonHeir);
        vm.expectRevert(LegacyVault.HeirNotRegistered.selector);
        vault.initiateClaim();
    }

    function test_removedHeirCannotInitiateClaim() public {
        vm.prank(owner);
        vault.removeHeir(heir);

        _warpToRed();
        vm.prank(heir);
        vm.expectRevert(LegacyVault.HeirNotRegistered.selector);
        vault.initiateClaim();
    }

    // ---------------------------------------------------------------------
    // Layer 2: per-heir claim flow
    // ---------------------------------------------------------------------

    function test_RevertWhen_InitiateClaimWhileGreen() public {
        vm.prank(heir);
        vm.expectRevert(LegacyVault.VaultNotRed.selector);
        vault.initiateClaim();
    }

    function test_RevertWhen_InitiateClaimWhileAmber() public {
        vm.warp(block.timestamp + CHECK_IN_INTERVAL + 1);
        vm.prank(heir);
        vm.expectRevert(LegacyVault.VaultNotRed.selector);
        vault.initiateClaim();
    }

    function test_InitiateClaimSucceedsWhileRed() public {
        _warpToRed();
        vm.prank(heir);
        vault.initiateClaim();

        assertEq(uint256(vault.claimStatus(heir)), uint256(LegacyVault.ClaimStatus.Contestable));
    }

    function test_RevertWhen_InitiateClaimCalledTwice() public {
        _warpToRed();
        vm.prank(heir);
        vault.initiateClaim();

        vm.prank(heir);
        vm.expectRevert(LegacyVault.ClaimAlreadyInitiated.selector);
        vault.initiateClaim();
    }

    function test_FinalizeClaimSucceedsAfterWindowElapses() public {
        _warpToRed();
        vm.prank(heir);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir);
        vault.finalizeClaim();

        assertEq(uint256(vault.claimStatus(heir)), uint256(LegacyVault.ClaimStatus.Claimed));
    }

    function test_RevertWhen_FinalizeClaimBeforeWindowElapses() public {
        _warpToRed();
        vm.prank(heir);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW - 1);
        vm.prank(heir);
        vm.expectRevert(LegacyVault.ContestableWindowNotElapsed.selector);
        vault.finalizeClaim();
    }

    function test_RevertWhen_FinalizeClaimWithoutInitiating() public {
        _warpToRed();
        vm.prank(heir);
        vm.expectRevert(LegacyVault.ClaimNotContestable.selector);
        vault.finalizeClaim();
    }

    function test_OwnerCheckInInvalidatesPendingClaim() public {
        _warpToRed();
        vm.prank(heir);
        vault.initiateClaim();

        _checkIn();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir);
        vm.expectRevert(LegacyVault.VaultNotRed.selector);
        vault.finalizeClaim();
    }

    function test_RevertWhen_FinalizingStaleClaimAfterVaultGoesRedAgain() public {
        _warpToRed();
        vm.prank(heir);
        vault.initiateClaim();
        uint256 firstInitiatedAt = vault.claimInitiatedAt(heir);

        _checkIn();

        _warpToRed();
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Red));

        assertTrue(block.timestamp >= firstInitiatedAt + CONTESTABLE_WINDOW);
        vm.prank(heir);
        vm.expectRevert(LegacyVault.ClaimNotContestable.selector);
        vault.finalizeClaim();
    }

    function test_StaleClaimCanBeReInitiatedAfterCheckIn() public {
        _warpToRed();
        vm.prank(heir);
        vault.initiateClaim();

        _checkIn();

        _warpToRed();
        vm.prank(heir);
        vault.initiateClaim();

        assertEq(uint256(vault.claimStatus(heir)), uint256(LegacyVault.ClaimStatus.Contestable));
    }

    function test_HeirsAreIndependent() public {
        _warpToRed();
        vm.prank(heir);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir);
        vault.finalizeClaim();

        assertEq(uint256(vault.claimStatus(otherHeir)), uint256(LegacyVault.ClaimStatus.NotInitiated));
    }

    // ---------------------------------------------------------------------
    // Asset Allocation & Execution Tests
    // ---------------------------------------------------------------------

    function test_ownerCanAssignAsset() public {
        vm.prank(owner);
        vault.assignAsset(ASSET_2, otherHeir, mockExecutor);

        (address assignedHeir, IVaultExecutor executor, bytes32 assetId, bool exists, bool executed) =
            vault.allocations(ASSET_2);
        assertEq(assignedHeir, otherHeir);
        assertEq(address(executor), address(mockExecutor));
        assertEq(assetId, ASSET_2);
        assertTrue(exists);
        assertFalse(executed);
    }

    function test_revertWhen_AssignAssetWithZeroId() public {
        vm.prank(owner);
        vm.expectRevert(LegacyVault.InvalidAssetId.selector);
        vault.assignAsset(bytes32(0), heir, mockExecutor);
    }

    function test_revertWhen_AssignAssetWithZeroExecutor() public {
        vm.prank(owner);
        vm.expectRevert(LegacyVault.InvalidExecutor.selector);
        vault.assignAsset(ASSET_2, heir, IVaultExecutor(address(0)));
    }

    function test_revertWhen_AssignAssetToNonHeir() public {
        vm.prank(owner);
        vm.expectRevert(LegacyVault.HeirNotRegistered.selector);
        vault.assignAsset(ASSET_2, nonHeir, mockExecutor);
    }

    function test_revertWhen_AssignAssetAlreadyAssigned() public {
        vm.prank(owner);
        vm.expectRevert(LegacyVault.AssetAlreadyAssigned.selector);
        vault.assignAsset(ASSET_1, otherHeir, mockExecutor);
    }

    function test_revertWhen_AssignAssetWhileAmber() public {
        vm.warp(block.timestamp + CHECK_IN_INTERVAL);
        vm.prank(owner);
        vm.expectRevert(LegacyVault.HeirChangesLocked.selector);
        vault.assignAsset(ASSET_2, otherHeir, mockExecutor);
    }

    function test_revertWhen_AssignAssetWhileRed() public {
        _warpToRed();
        vm.prank(owner);
        vm.expectRevert(LegacyVault.HeirChangesLocked.selector);
        vault.assignAsset(ASSET_2, otherHeir, mockExecutor);
    }

    function test_revertWhen_NonOwnerAssignsAsset() public {
        vm.prank(attacker);
        vm.expectRevert(LegacyVault.NotOwner.selector);
        vault.assignAsset(ASSET_2, otherHeir, mockExecutor);
    }

    function test_ownerCanRemoveAsset() public {
        vm.prank(owner);
        vault.removeAsset(ASSET_1);

        (,,, bool exists,) = vault.allocations(ASSET_1);
        assertFalse(exists);
    }

    function test_revertWhen_RemoveNonExistentAsset() public {
        vm.prank(owner);
        vm.expectRevert(LegacyVault.AssetNotAssigned.selector);
        vault.removeAsset(keccak256("UNKNOWN"));
    }

    function test_revertWhen_RemoveAssetWhileAmber() public {
        vm.warp(block.timestamp + CHECK_IN_INTERVAL);
        vm.prank(owner);
        vm.expectRevert(LegacyVault.HeirChangesLocked.selector);
        vault.removeAsset(ASSET_1);
    }

    function test_revertWhen_NonOwnerRemovesAsset() public {
        vm.prank(attacker);
        vm.expectRevert(LegacyVault.NotOwner.selector);
        vault.removeAsset(ASSET_1);
    }

    function test_executeClaimHappyPath() public {
        _warpToRed();
        vm.prank(heir);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir);
        vault.finalizeClaim();

        vm.prank(heir);
        vault.executeClaim(ASSET_1);

        assertEq(mockExecutor.callCount(), 1);
        assertEq(mockExecutor.lastFrom(), owner);
        assertEq(mockExecutor.lastTo(), heir);

        (,,,, bool executed) = vault.allocations(ASSET_1);
        assertTrue(executed);
    }

    function test_revertWhen_ExecuteClaimBeforeFinalized() public {
        _warpToRed();
        vm.prank(heir);
        vault.initiateClaim();

        vm.prank(heir);
        vm.expectRevert(LegacyVault.ClaimNotFinalized.selector);
        vault.executeClaim(ASSET_1);
    }

    function test_revertWhen_ExecuteClaimByWrongHeir() public {
        _warpToRed();
        vm.prank(otherHeir);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(otherHeir);
        vault.finalizeClaim();

        // otherHeir tries to claim ASSET_1 which was allocated to heir
        vm.prank(otherHeir);
        vm.expectRevert(LegacyVault.NotAssignedHeir.selector);
        vault.executeClaim(ASSET_1);
    }

    function test_revertWhen_ExecuteClaimNonExistentAsset() public {
        _warpToRed();
        vm.prank(heir);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir);
        vault.finalizeClaim();

        vm.prank(heir);
        vm.expectRevert(LegacyVault.AssetNotAssigned.selector);
        vault.executeClaim(keccak256("NON_EXISTENT"));
    }

    function test_revertWhen_ExecuteClaimAlreadyClaimed() public {
        _warpToRed();
        vm.prank(heir);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir);
        vault.finalizeClaim();

        vm.prank(heir);
        vault.executeClaim(ASSET_1);

        vm.prank(heir);
        vm.expectRevert(LegacyVault.AssetAlreadyClaimed.selector);
        vault.executeClaim(ASSET_1);
    }

    function test_revertWhen_ExecuteClaimExecutorReverts() public {
        mockExecutor.setShouldRevert(true);

        _warpToRed();
        vm.prank(heir);
        vault.initiateClaim();

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir);
        vault.finalizeClaim();

        vm.prank(heir);
        vm.expectRevert("MockVaultExecutor: transfer failed");
        vault.executeClaim(ASSET_1);
    }
}
