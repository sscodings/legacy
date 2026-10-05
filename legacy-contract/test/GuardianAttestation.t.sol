// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LegacyVault} from "../src/LegacyVault.sol";
import {LegacyVaultFactory} from "../src/LegacyVaultFactory.sol";
import {WorldIDVerifierAdapter} from "../src/adapters/WorldIDVerifierAdapter.sol";
import {MockWorldID} from "./mocks/MockWorldID.sol";

/// @notice Coverage for guardian nomination and the unanimous death-attestation
///         mechanism that reduces every timelock on the vault by 99%.
contract GuardianAttestationTest is Test {
    LegacyVault public vault;
    LegacyVaultFactory public factory;
    WorldIDVerifierAdapter public verifierAdapter;
    MockWorldID public mockWorldId;

    address owner = address(0xA11CE);
    address heir = address(0xBEEF);
    address g1 = address(0x6001);
    address g2 = address(0x6002);
    address g3 = address(0x6003);
    address stranger = address(0xBAD);

    uint256 constant CHECK_IN_INTERVAL = 30 days;
    uint256 constant GRACE_PERIOD = 7 days;
    uint256 constant CONTESTABLE_WINDOW = 3 days;

    uint256 constant DUMMY_ROOT = 1;
    uint256 constant DUMMY_NULLIFIER = 42;
    uint256[8] DUMMY_PROOF = [uint256(0), 0, 0, 0, 0, 0, 0, 0];

    function setUp() public {
        mockWorldId = new MockWorldID();
        verifierAdapter = new WorldIDVerifierAdapter(mockWorldId, 1, 12345);

        LegacyVault implementation = new LegacyVault();
        factory = new LegacyVaultFactory(address(implementation));

        vm.prank(owner);
        vault = LegacyVault(factory.createVault(verifierAdapter, CHECK_IN_INTERVAL, GRACE_PERIOD, CONTESTABLE_WINDOW));

        vm.prank(owner);
        vault.registerLiveness(abi.encode(DUMMY_ROOT, DUMMY_NULLIFIER, DUMMY_PROOF));

        vm.prank(owner);
        vault.addHeir(heir);
    }

    function _checkIn() internal {
        vm.prank(owner);
        vault.checkIn(abi.encode(DUMMY_ROOT, DUMMY_NULLIFIER, DUMMY_PROOF));
    }

    function _addGuardian(address g) internal {
        vm.prank(owner);
        vault.addGuardian(g);
    }

    // ------------------------------------------------------------------
    // Guardian management
    // ------------------------------------------------------------------

    function test_ownerCanAddGuardian() public {
        _addGuardian(g1);
        assertTrue(vault.isGuardian(g1));
        assertEq(vault.getGuardianCount(), 1);
        assertEq(vault.getGuardians()[0], g1);
    }

    function test_revertWhen_AddGuardianZeroOrOwner() public {
        vm.prank(owner);
        vm.expectRevert(LegacyVault.InvalidGuardian.selector);
        vault.addGuardian(address(0));

        vm.prank(owner);
        vm.expectRevert(LegacyVault.InvalidGuardian.selector);
        vault.addGuardian(owner);
    }

    function test_revertWhen_AddGuardianTwice() public {
        _addGuardian(g1);
        vm.prank(owner);
        vm.expectRevert(LegacyVault.GuardianAlreadyRegistered.selector);
        vault.addGuardian(g1);
    }

    function test_revertWhen_NonOwnerAddsGuardian() public {
        vm.prank(stranger);
        vm.expectRevert(LegacyVault.NotOwner.selector);
        vault.addGuardian(g1);
    }

    function test_revertWhen_AddGuardianWhileNotGreen() public {
        vm.warp(block.timestamp + CHECK_IN_INTERVAL + 1); // Amber
        vm.prank(owner);
        vm.expectRevert(LegacyVault.HeirChangesLocked.selector);
        vault.addGuardian(g1);
    }

    function test_ownerCanRemoveGuardian() public {
        _addGuardian(g1);
        _addGuardian(g2);
        vm.prank(owner);
        vault.removeGuardian(g1);
        assertFalse(vault.isGuardian(g1));
        assertEq(vault.getGuardianCount(), 1);
        assertEq(vault.getGuardians()[0], g2);
    }

    // ------------------------------------------------------------------
    // Attestation & confirmation
    // ------------------------------------------------------------------

    function test_revertWhen_NonGuardianAttests() public {
        _addGuardian(g1);
        vm.prank(stranger);
        vm.expectRevert(LegacyVault.NotGuardian.selector);
        vault.attestDeath();
    }

    function test_singleGuardianUnanimousConfirmsDeath() public {
        _addGuardian(g1);
        vm.prank(g1);
        vault.attestDeath();
        assertTrue(vault.deathConfirmed());
        assertEq(vault.deathConfirmedAt(), block.timestamp);
    }

    function test_partialAttestationDoesNotConfirm() public {
        _addGuardian(g1);
        _addGuardian(g2);
        _addGuardian(g3);

        vm.prank(g1);
        vault.attestDeath();
        vm.prank(g2);
        vault.attestDeath();

        assertFalse(vault.deathConfirmed());
        assertEq(vault.deathAttestationCount(), 2);

        vm.prank(g3);
        vault.attestDeath();
        assertTrue(vault.deathConfirmed());
    }

    function test_revertWhen_AttestingTwice() public {
        _addGuardian(g1);
        _addGuardian(g2);
        vm.prank(g1);
        vault.attestDeath();
        vm.prank(g1);
        vm.expectRevert(LegacyVault.AlreadyAttestedDeath.selector);
        vault.attestDeath();
    }

    function test_guardianCanRevokeBeforeConfirmation() public {
        _addGuardian(g1);
        _addGuardian(g2);
        vm.prank(g1);
        vault.attestDeath();
        vm.prank(g1);
        vault.revokeAttestation();
        assertEq(vault.deathAttestationCount(), 0);
        assertFalse(vault.hasAttestedDeath(g1));
    }

    function test_revertWhen_RevokeAfterConfirmed() public {
        _addGuardian(g1);
        vm.prank(g1);
        vault.attestDeath(); // confirms (unanimous)
        vm.prank(g1);
        vm.expectRevert(LegacyVault.DeathAlreadyConfirmed.selector);
        vault.revokeAttestation();
    }

    function test_removingDissenterCompletesUnanimity() public {
        _addGuardian(g1);
        _addGuardian(g2);

        vm.prank(g1);
        vault.attestDeath();
        assertFalse(vault.deathConfirmed());

        // Removing the guardian who hasn't attested makes the set unanimous.
        vm.prank(owner);
        vault.removeGuardian(g2);
        assertTrue(vault.deathConfirmed());
    }

    // ------------------------------------------------------------------
    // Acceleration effect on the timelock
    // ------------------------------------------------------------------

    function test_deathConfirmationAcceleratesStatusToRed() public {
        _addGuardian(g1);

        // 10% into the nominal interval: normally solidly Green.
        vm.warp(block.timestamp + CHECK_IN_INTERVAL / 10);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Green));

        // Death confirmed → effective (interval+grace) is 1% of nominal, well
        // under the elapsed time → immediately Red.
        vm.prank(g1);
        vault.attestDeath();
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Red));
    }

    function test_effectiveTimelockReflectsReduction() public {
        _addGuardian(g1);

        (uint256 i0, uint256 g0, uint256 c0) = vault.getEffectiveTimelock();
        assertEq(i0, CHECK_IN_INTERVAL);
        assertEq(g0, GRACE_PERIOD);
        assertEq(c0, CONTESTABLE_WINDOW);

        vm.prank(g1);
        vault.attestDeath();

        (uint256 i1, uint256 g1v, uint256 c1) = vault.getEffectiveTimelock();
        assertEq(i1, CHECK_IN_INTERVAL / 100);
        assertEq(g1v, GRACE_PERIOD / 100);
        assertEq(c1, CONTESTABLE_WINDOW / 100);
    }

    function test_acceleratedEndToEndInheritance() public {
        _addGuardian(g1);
        _addGuardian(g2);

        // Owner "dies" shortly after a check-in.
        vm.warp(block.timestamp + 1 days);

        vm.prank(g1);
        vault.attestDeath();
        vm.prank(g2);
        vault.attestDeath();
        assertTrue(vault.deathConfirmed());

        // Vault is Red under the accelerated timelock; heir initiates.
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Red));
        vm.prank(heir);
        vault.initiateClaim();

        // Effective contestable window is 3 days / 100 ≈ 43 minutes.
        vm.warp(block.timestamp + (CONTESTABLE_WINDOW / 100) + 1);
        vm.prank(heir);
        vault.finalizeClaim();
        assertEq(uint256(vault.claimStatus(heir)), uint256(LegacyVault.ClaimStatus.Claimed));
    }

    // ------------------------------------------------------------------
    // Owner liveness overrides attestations
    // ------------------------------------------------------------------

    function test_checkInResetsConfirmedDeath() public {
        _addGuardian(g1);
        vm.prank(g1);
        vault.attestDeath();
        assertTrue(vault.deathConfirmed());

        _checkIn();

        assertFalse(vault.deathConfirmed());
        assertEq(vault.deathAttestationCount(), 0);
        assertFalse(vault.hasAttestedDeath(g1));
        (uint256 i,,) = vault.getEffectiveTimelock();
        assertEq(i, CHECK_IN_INTERVAL);
    }

    function test_guardianCanReAttestAfterReset() public {
        _addGuardian(g1);
        vm.prank(g1);
        vault.attestDeath();
        _checkIn();

        // Attestation cleared, guardian may attest again.
        vm.prank(g1);
        vault.attestDeath();
        assertTrue(vault.deathConfirmed());
    }

    function test_vaultWithNoGuardiansNeverAccelerates() public {
        // No guardians nominated → attestation impossible, timelock nominal.
        vm.warp(block.timestamp + CHECK_IN_INTERVAL / 2);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Green));
        assertFalse(vault.deathConfirmed());
    }
}
