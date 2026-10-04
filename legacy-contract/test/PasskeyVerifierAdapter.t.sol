// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {LegacyVault} from "../src/LegacyVault.sol";
import {LegacyVaultFactory} from "../src/LegacyVaultFactory.sol";
import {PasskeyVerifierAdapter} from "../src/adapters/PasskeyVerifierAdapter.sol";

/// @notice End-to-end tests for passkey liveness. Every assertion here is a real
///         WebAuthn assertion signed with a P-256 key via `vm.signP256` and
///         verified by OpenZeppelin's WebAuthn library through the 0x100
///         precompile — nothing about the verifier is mocked.
contract PasskeyVerifierAdapterTest is Test {
    LegacyVaultFactory factory;
    PasskeyVerifierAdapter passkey;
    LegacyVault vault;

    address owner = address(0xA11CE);
    address heir = address(0xBEEF);
    address attacker = address(0xBAD);

    // Arbitrary fixed P-256 private keys.
    uint256 constant OWNER_KEY = 0x519b423d715f8b581f4fa8ee59f4771a5b44c8130b4e3eacca54a56dda72b464;
    uint256 constant ATTACKER_KEY = 0x0f56db78ca460b055f6b44bd7d9a6b3a9f4c4fc6fc3c2f7a5e3b8f8b2d1c0a99;

    // secp256r1 group order.
    uint256 constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    // Authenticator data flags.
    bytes1 constant UP = 0x01; // user present
    bytes1 constant UV = 0x04; // user verified (biometric / PIN)
    bytes1 constant BE = 0x08; // backup eligible
    bytes1 constant BS = 0x10; // backed up (synced passkey)

    uint256 constant CHECK_IN_INTERVAL = 30 days;
    uint256 constant GRACE_PERIOD = 7 days;
    uint256 constant CONTESTABLE_WINDOW = 3 days;

    function setUp() public {
        passkey = new PasskeyVerifierAdapter();
        factory = new LegacyVaultFactory(address(new LegacyVault()));

        vm.prank(owner);
        vault = LegacyVault(factory.createVault(passkey, CHECK_IN_INTERVAL, GRACE_PERIOD, CONTESTABLE_WINDOW));
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _pubKey(uint256 key) internal pure returns (bytes32 qx, bytes32 qy) {
        (uint256 x, uint256 y) = vm.publicKeyP256(key);
        return (bytes32(x), bytes32(y));
    }

    /// @dev Builds a WebAuthn assertion the way a browser would for
    ///      `navigator.credentials.get({ publicKey: { challenge } })`.
    function _assertion(uint256 key, bytes32 challenge, string memory ceremony, bytes1 flags)
        internal
        pure
        returns (WebAuthn.WebAuthnAuth memory auth)
    {
        bytes memory authenticatorData = abi.encodePacked(sha256("localhost"), flags, uint32(1));

        // {"type":"<ceremony>","challenge":"<base64url(challenge)>",...}
        string memory typeField = string.concat('"type":"', ceremony, '"');
        string memory clientDataJSON = string.concat(
            "{",
            typeField,
            ',"challenge":"',
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"http://localhost:3000","crossOrigin":false}'
        );

        bytes32 digest = sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(key, digest);
        if (uint256(s) > N / 2) s = bytes32(N - uint256(s)); // canonical low-s, as browsers do not guarantee it

        auth = WebAuthn.WebAuthnAuth({
            r: r,
            s: s,
            typeIndex: 1, // just past the opening brace
            challengeIndex: 1 + bytes(typeField).length + 1, // past `"type":"..."` and the comma
            authenticatorData: authenticatorData,
            clientDataJSON: clientDataJSON
        });
    }

    function _get(uint256 key, bytes32 challenge) internal pure returns (WebAuthn.WebAuthnAuth memory) {
        return _assertion(key, challenge, "webauthn.get", UP | UV);
    }

    function _registrationProof(uint256 key, bytes32 challenge) internal pure returns (bytes memory) {
        (bytes32 qx, bytes32 qy) = _pubKey(key);
        return abi.encode(qx, qy, _get(key, challenge));
    }

    function _register() internal {
        bytes memory proof = _registrationProof(OWNER_KEY, vault.livenessChallenge());
        vm.prank(owner);
        vault.registerLiveness(proof);
    }

    function _checkInProof() internal view returns (bytes memory) {
        return abi.encode(_get(OWNER_KEY, vault.livenessChallenge()));
    }

    // ---------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------

    function test_RegisterBindsPasskeyToVault() public {
        _register();

        (bytes32 qx, bytes32 qy) = _pubKey(OWNER_KEY);
        (bytes32 storedX, bytes32 storedY) = passkey.credentialOf(address(vault));

        assertTrue(vault.livenessRegistered());
        assertTrue(passkey.isRegistered(address(vault)));
        assertEq(storedX, qx);
        assertEq(storedY, qy);
        assertEq(vault.livenessNonce(), 1);
    }

    function test_RegisterEmitsCredentialRegistered() public {
        (bytes32 qx, bytes32 qy) = _pubKey(OWNER_KEY);
        bytes memory proof = _registrationProof(OWNER_KEY, vault.livenessChallenge());

        vm.expectEmit(true, false, false, true, address(passkey));
        emit PasskeyVerifierAdapter.CredentialRegistered(address(vault), qx, qy);

        vm.prank(owner);
        vault.registerLiveness(proof);
    }

    function test_RevertWhen_RegisterWithoutProofOfPossession() public {
        // Declares the owner's public key but the assertion is signed by another key.
        (bytes32 qx, bytes32 qy) = _pubKey(OWNER_KEY);
        bytes memory proof = abi.encode(qx, qy, _get(ATTACKER_KEY, vault.livenessChallenge()));

        vm.prank(owner);
        vm.expectRevert(PasskeyVerifierAdapter.InvalidAssertion.selector);
        vault.registerLiveness(proof);
    }

    function test_RevertWhen_RegisterOffCurvePublicKey() public {
        bytes memory proof =
            abi.encode(bytes32(uint256(1)), bytes32(uint256(2)), _get(OWNER_KEY, vault.livenessChallenge()));

        vm.prank(owner);
        vm.expectRevert(PasskeyVerifierAdapter.InvalidPublicKey.selector);
        vault.registerLiveness(proof);
    }

    function test_RevertWhen_RegisterTwice() public {
        _register();
        bytes memory proof = _registrationProof(OWNER_KEY, vault.livenessChallenge());

        vm.prank(owner);
        vm.expectRevert(LegacyVault.LivenessAlreadyRegistered.selector);
        vault.registerLiveness(proof);
    }

    function test_RevertWhen_NonOwnerRegisters() public {
        bytes memory proof = _registrationProof(ATTACKER_KEY, vault.livenessChallenge());

        vm.prank(attacker);
        vm.expectRevert(LegacyVault.NotOwner.selector);
        vault.registerLiveness(proof);
    }

    /// @notice Calling the shared adapter directly can only ever bind a key to the
    ///         caller's own address — it cannot touch anyone's vault.
    function test_DirectAdapterCallCannotHijackVault() public {
        bytes32 challenge = vault.livenessChallenge();
        bytes memory attackerProof = _registrationProof(ATTACKER_KEY, challenge);

        vm.prank(attacker);
        passkey.registerCredential(owner, challenge, attackerProof);

        assertTrue(passkey.isRegistered(attacker));
        assertFalse(passkey.isRegistered(address(vault)));

        // The real owner registers normally afterwards.
        _register();
        (bytes32 qx,) = _pubKey(OWNER_KEY);
        (bytes32 storedX,) = passkey.credentialOf(address(vault));
        assertEq(storedX, qx);
    }

    // ---------------------------------------------------------------------
    // Check-in
    // ---------------------------------------------------------------------

    function test_CheckInWithPasskeyResetsTimer() public {
        _register();
        vm.warp(block.timestamp + CHECK_IN_INTERVAL + 1);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Amber));

        bytes memory proof = _checkInProof();
        vm.prank(owner);
        vault.checkIn(proof);

        assertEq(vault.lastCheckIn(), block.timestamp);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Green));
        assertEq(vault.livenessNonce(), 2);
    }

    function test_SyncedPasskeyIsAccepted() public {
        // iCloud Keychain / Google Password Manager passkeys report BE and BS.
        _register();
        bytes memory proof =
            abi.encode(_assertion(OWNER_KEY, vault.livenessChallenge(), "webauthn.get", UP | UV | BE | BS));

        vm.prank(owner);
        vault.checkIn(proof);
        assertEq(vault.livenessNonce(), 2);
    }

    function test_ConsecutiveCheckInsEachNeedAFreshAssertion() public {
        _register();
        for (uint256 i = 0; i < 3; i++) {
            vm.warp(block.timestamp + 1 days);
            bytes memory proof = _checkInProof();
            vm.prank(owner);
            vault.checkIn(proof);
        }
        assertEq(vault.livenessNonce(), 4);
    }

    function test_RevertWhen_AssertionIsReplayed() public {
        _register();
        bytes memory proof = _checkInProof();

        vm.prank(owner);
        vault.checkIn(proof);

        // Same assertion again: the nonce moved, so the challenge no longer matches.
        vm.prank(owner);
        vm.expectRevert(PasskeyVerifierAdapter.InvalidAssertion.selector);
        vault.checkIn(proof);
    }

    function test_RevertWhen_RegistrationAssertionReusedAsCheckIn() public {
        bytes32 registrationChallenge = vault.livenessChallenge();
        _register();

        bytes memory proof = abi.encode(_get(OWNER_KEY, registrationChallenge));
        vm.prank(owner);
        vm.expectRevert(PasskeyVerifierAdapter.InvalidAssertion.selector);
        vault.checkIn(proof);
    }

    function test_RevertWhen_AssertionFromAnotherVault() public {
        _register();

        // A second vault owned by the same person, using the same passkey.
        vm.prank(owner);
        LegacyVault other =
            LegacyVault(factory.createVault(passkey, CHECK_IN_INTERVAL, GRACE_PERIOD, CONTESTABLE_WINDOW));
        bytes memory otherRegistration = _registrationProof(OWNER_KEY, other.livenessChallenge());
        vm.prank(owner);
        other.registerLiveness(otherRegistration);

        // Both vaults sit at nonce 1, but their challenges differ by address.
        assertTrue(other.livenessChallenge() != vault.livenessChallenge());

        bytes memory proofForOther = abi.encode(_get(OWNER_KEY, other.livenessChallenge()));
        vm.prank(owner);
        vm.expectRevert(PasskeyVerifierAdapter.InvalidAssertion.selector);
        vault.checkIn(proofForOther);
    }

    function test_RevertWhen_AssertionFromAnotherChain() public {
        _register();
        bytes32 challengeHere = vault.livenessChallenge();

        vm.chainId(block.chainid + 1);
        assertTrue(vault.livenessChallenge() != challengeHere);

        bytes memory proof = abi.encode(_get(OWNER_KEY, challengeHere));
        vm.prank(owner);
        vm.expectRevert(PasskeyVerifierAdapter.InvalidAssertion.selector);
        vault.checkIn(proof);
    }

    function test_RevertWhen_SignedByDifferentPasskey() public {
        _register();
        bytes memory proof = abi.encode(_get(ATTACKER_KEY, vault.livenessChallenge()));

        vm.prank(owner);
        vm.expectRevert(PasskeyVerifierAdapter.InvalidAssertion.selector);
        vault.checkIn(proof);
    }

    function test_RevertWhen_HighSMalleableSignature() public {
        _register();
        WebAuthn.WebAuthnAuth memory auth = _get(OWNER_KEY, vault.livenessChallenge());
        auth.s = bytes32(N - uint256(auth.s)); // the other valid form of the same signature

        vm.prank(owner);
        vm.expectRevert(PasskeyVerifierAdapter.InvalidAssertion.selector);
        vault.checkIn(abi.encode(auth));
    }

    function test_RevertWhen_UserNotVerified() public {
        // A tap without biometric/PIN sets UP but not UV.
        _register();
        bytes memory proof = abi.encode(_assertion(OWNER_KEY, vault.livenessChallenge(), "webauthn.get", UP));

        vm.prank(owner);
        vm.expectRevert(PasskeyVerifierAdapter.InvalidAssertion.selector);
        vault.checkIn(proof);
    }

    function test_RevertWhen_WrongCeremonyType() public {
        _register();
        bytes memory proof = abi.encode(_assertion(OWNER_KEY, vault.livenessChallenge(), "webauthn.create", UP | UV));

        vm.prank(owner);
        vm.expectRevert(PasskeyVerifierAdapter.InvalidAssertion.selector);
        vault.checkIn(proof);
    }

    function test_RevertWhen_ClientDataTamperedAfterSigning() public {
        _register();
        WebAuthn.WebAuthnAuth memory auth = _get(OWNER_KEY, vault.livenessChallenge());
        auth.clientDataJSON = string.concat(auth.clientDataJSON, " ");

        vm.prank(owner);
        vm.expectRevert(PasskeyVerifierAdapter.InvalidAssertion.selector);
        vault.checkIn(abi.encode(auth));
    }

    function test_RevertWhen_NonOwnerSubmitsValidAssertion() public {
        _register();
        bytes memory proof = _checkInProof();

        vm.prank(attacker);
        vm.expectRevert(LegacyVault.NotOwner.selector);
        vault.checkIn(proof);
    }

    function test_RevertWhen_CheckInBeforeRegistration() public {
        bytes memory proof = _checkInProof();

        vm.prank(owner);
        vm.expectRevert(LegacyVault.LivenessNotRegistered.selector);
        vault.checkIn(proof);
    }

    function test_RevertWhen_AdapterQueriedForUnregisteredVault() public {
        bytes memory proof = abi.encode(_get(OWNER_KEY, bytes32(0)));

        vm.prank(attacker);
        vm.expectRevert(PasskeyVerifierAdapter.NotRegistered.selector);
        passkey.verifyLiveness(owner, bytes32(0), proof);
    }

    // ---------------------------------------------------------------------
    // Succession interplay
    // ---------------------------------------------------------------------

    /// @notice A passkey check-in during the contestable window defeats a wrongful claim.
    function test_PasskeyCheckInDefeatsWrongfulClaim() public {
        _register();
        vm.prank(owner);
        vault.addHeir(heir);

        vm.warp(block.timestamp + CHECK_IN_INTERVAL + GRACE_PERIOD);
        vm.prank(heir);
        vault.initiateClaim();

        bytes memory proof = _checkInProof();
        vm.prank(owner);
        vault.checkIn(proof);

        vm.warp(block.timestamp + CONTESTABLE_WINDOW);
        vm.prank(heir);
        vm.expectRevert(LegacyVault.VaultNotRed.selector);
        vault.finalizeClaim();
    }
}
