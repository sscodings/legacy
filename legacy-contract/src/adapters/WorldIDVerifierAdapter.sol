// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ILivenessVerifier} from "../interfaces/ILivenessVerifier.sol";

interface IWorldID {
    function verifyProof(
        uint256 root,
        uint256 groupId,
        uint256 signalHash,
        uint256 nullifierHash,
        uint256 externalNullifierHash,
        uint256[8] calldata proof
    ) external view;
}

/// @title WorldIDVerifierAdapter
/// @notice Wraps World ID 3.0 proof verification and nullifier binding for
///         LegacyVault liveness "heartbeat" check-ins.
/// @dev Testnet verification uses MockWorldID, matching Worldcoin's own World Chain Template App
///      testing pattern (Simulator proofs + standalone verifier). Production path uses the same
///      adapter code pointed at the live WorldIDRouter with no code changes required.
///
///      One adapter is shared by many vaults, so every binding is keyed by
///      `msg.sender` — the vault calling in — never by a caller-supplied
///      address. (A previous version accepted the vault as a parameter, which
///      let anyone with a World ID bind their own nullifier to another
///      owner's vault before the owner registered, locking them out of
///      check-ins for good.)
///
///      World ID proofs commit to the signal hash(vault, owner), not to the
///      vault's per-check-in challenge, so a proof can be resubmitted. That is
///      why LegacyVault restricts `checkIn` to the owner: replaying a proof
///      requires the owner's own key.
///
///      Proof encoding (both functions): abi.encode(uint256 root, uint256 nullifierHash, uint256[8] proof)
contract WorldIDVerifierAdapter is ILivenessVerifier {
    IWorldID public immutable worldId;
    uint256 public immutable groupId; // 1 = orb-verified
    uint256 public immutable externalNullifierHash; // derived from app ID + action ID

    mapping(address vault => uint256 registeredNullifierHash) public vaultNullifier;

    error NullifierNotRegistered();
    error NullifierMismatch();
    error AlreadyRegistered();
    error InvalidNullifier();

    constructor(IWorldID _worldId, uint256 _groupId, uint256 _externalNullifierHash) {
        worldId = _worldId;
        groupId = _groupId;
        externalNullifierHash = _externalNullifierHash;
    }

    /// @inheritdoc ILivenessVerifier
    function registerCredential(address owner, bytes32, bytes calldata proof) external {
        if (vaultNullifier[msg.sender] != 0) revert AlreadyRegistered();

        (uint256 root, uint256 nullifierHash, uint256[8] memory zkProof) =
            abi.decode(proof, (uint256, uint256, uint256[8]));

        // Zero is the "unregistered" sentinel, so it can never be a binding.
        if (nullifierHash == 0) revert InvalidNullifier();

        worldId.verifyProof(
            root, groupId, _hashSignal(msg.sender, owner), nullifierHash, externalNullifierHash, zkProof
        );

        vaultNullifier[msg.sender] = nullifierHash;
    }

    /// @inheritdoc ILivenessVerifier
    function verifyLiveness(address owner, bytes32, bytes calldata proof) external view {
        uint256 registered = vaultNullifier[msg.sender];
        if (registered == 0) revert NullifierNotRegistered();

        (uint256 root, uint256 nullifierHash, uint256[8] memory zkProof) =
            abi.decode(proof, (uint256, uint256, uint256[8]));

        if (nullifierHash != registered) revert NullifierMismatch();

        worldId.verifyProof(
            root, groupId, _hashSignal(msg.sender, owner), nullifierHash, externalNullifierHash, zkProof
        );
    }

    function hashSignal(address vault, address signalAddress) external pure returns (uint256) {
        return _hashSignal(vault, signalAddress);
    }

    function _hashSignal(address vault, address signalAddress) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(vault, signalAddress))) >> 8;
    }
}
