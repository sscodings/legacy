// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title ILivenessVerifier
/// @notice Proof-of-liveness primitive that a LegacyVault delegates check-ins to.
/// @dev The vault never interprets `proof`: each implementation defines its own
///      encoding, so the liveness mechanism can be swapped (World ID, passkeys,
///      ...) without touching vault logic.
///
///      SECURITY: implementations MUST key every piece of per-vault state by
///      `msg.sender` (the calling vault) and never by a caller-supplied vault
///      address. A verifier is shared by many vaults, so accepting a vault
///      address as a parameter would let any third party bind their own
///      credential to somebody else's vault and lock its owner out.
interface ILivenessVerifier {
    /// @notice Binds a liveness credential to the calling vault. Called once.
    /// @param owner     The vault owner, for implementations that bind proofs to it.
    /// @param challenge Single-use, vault-supplied value. Implementations whose
    ///                  proofs can commit to arbitrary data SHOULD require it.
    /// @param proof     Implementation-defined credential plus proof of possession.
    function registerCredential(address owner, bytes32 challenge, bytes calldata proof) external;

    /// @notice Reverts unless `proof` demonstrates liveness of the credential
    ///         bound to the calling vault.
    /// @param owner     The vault owner, for implementations that bind proofs to it.
    /// @param challenge Single-use, vault-supplied value. Implementations whose
    ///                  proofs can commit to arbitrary data SHOULD require it.
    /// @param proof     Implementation-defined liveness proof.
    function verifyLiveness(address owner, bytes32 challenge, bytes calldata proof) external view;
}
