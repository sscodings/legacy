// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILivenessVerifier} from "../interfaces/ILivenessVerifier.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

/// @title PasskeyVerifierAdapter
/// @notice Liveness via a WebAuthn passkey (secp256r1 / P-256), verified fully
///         on-chain. No seed phrase, no oracle, no relying-party server.
/// @dev At registration the owner binds the passkey's public key to their vault,
///      proving possession by signing the vault's current challenge. Every
///      check-in must then be a fresh WebAuthn assertion from that same key over
///      the vault's next challenge.
///
///      What this proves: the device-held credential bound when the vault was
///      set up is still being used, and that the authenticator performed user
///      verification (biometric or device PIN) — the `UV` flag is required.
///      What it does not prove: that the holder is a unique human. That is a
///      deliberate trade; succession needs no sybil resistance, but it does
///      benefit from having no third party in the liveness path.
///
///      Verification is delegated to OpenZeppelin's audited WebAuthn library,
///      which checks the `webauthn.get` type, the challenge, the UP/UV flags and
///      BE/BS consistency, and verifies the P-256 signature through the 0x100
///      precompile (EIP-7951 on Monad), rejecting high-s malleable signatures
///      and invalid public keys. Origin and RP ID checks are intentionally
///      left to the authenticator, as documented in that library.
///
///      Replay protection comes from the challenge: the vault derives it from a
///      nonce it increments after every successful registration and check-in,
///      so each assertion is valid exactly once.
///
///      Proof encodings:
///        registerCredential: abi.encode(bytes32 qx, bytes32 qy, WebAuthn.WebAuthnAuth auth)
///        verifyLiveness:     abi.encode(WebAuthn.WebAuthnAuth auth)
contract PasskeyVerifierAdapter is ILivenessVerifier {
    struct Credential {
        bytes32 qx;
        bytes32 qy;
    }

    mapping(address vault => Credential) private _credentials;

    event CredentialRegistered(address indexed vault, bytes32 qx, bytes32 qy);

    error AlreadyRegistered();
    error NotRegistered();
    error InvalidPublicKey();
    error InvalidAssertion();

    /// @inheritdoc ILivenessVerifier
    function registerCredential(address, bytes32 challenge, bytes calldata proof) external {
        if (isRegistered(msg.sender)) revert AlreadyRegistered();

        (bytes32 qx, bytes32 qy, WebAuthn.WebAuthnAuth memory auth) =
            abi.decode(proof, (bytes32, bytes32, WebAuthn.WebAuthnAuth));

        if (!P256.isValidPublicKey(qx, qy)) revert InvalidPublicKey();

        // Proof of possession: without it an owner could bind a key they do not
        // control and permanently lose the ability to check in.
        if (!WebAuthn.verify(abi.encodePacked(challenge), auth, qx, qy, true)) revert InvalidAssertion();

        _credentials[msg.sender] = Credential(qx, qy);

        emit CredentialRegistered(msg.sender, qx, qy);
    }

    /// @inheritdoc ILivenessVerifier
    function verifyLiveness(address, bytes32 challenge, bytes calldata proof) external view {
        Credential memory credential = _credentials[msg.sender];
        if (credential.qx == 0 && credential.qy == 0) revert NotRegistered();

        WebAuthn.WebAuthnAuth memory auth = abi.decode(proof, (WebAuthn.WebAuthnAuth));

        if (!WebAuthn.verify(abi.encodePacked(challenge), auth, credential.qx, credential.qy, true)) {
            revert InvalidAssertion();
        }
    }

    /// @notice The passkey public key bound to `vault`, or zero if none.
    function credentialOf(address vault) external view returns (bytes32 qx, bytes32 qy) {
        Credential memory credential = _credentials[vault];
        return (credential.qx, credential.qy);
    }

    /// @notice Whether `vault` has a passkey bound to it.
    function isRegistered(address vault) public view returns (bool) {
        Credential memory credential = _credentials[vault];
        return credential.qx != 0 || credential.qy != 0;
    }
}
