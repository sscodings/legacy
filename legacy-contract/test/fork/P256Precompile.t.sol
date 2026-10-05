// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";

/// @title P256PrecompileForkTest
/// @notice De-risking spike for the passkey liveness design.
/// @dev Monad documents P256 signature verification as a precompile at 0x0100
///      (EIP-7951, which supersedes RIP-7212 at the same address with an
///      identical interface). The whole passkey-based ILivenessVerifier plan
///      rests on this behaving as documented, so verify it before building on it.
///
///      Input  = 160 bytes, abi.encodePacked(hash, r, s, x, y)
///      Output = 32 bytes equal to 1 on success. A verification failure returns
///              *empty* returndata rather than 32 bytes of zero, so callers must
///              check the length and not just decode.
///
///      Precompiles have no bytecode, so `eth_getCode` at 0x0100 returns 0x
///      exactly as it does for ecrecover at 0x01. Presence can only be
///      established by calling it, which is what this test does.
///
///      Run against a live Monad fork:
///        forge test --match-path 'test/fork/P256Precompile.t.sol' \
///                   --fork-url https://rpc.monad.xyz -vv
contract P256PrecompileForkTest is Test {
    address constant P256_VERIFY = address(0x0100);

    /// @dev secp256r1 group order.
    uint256 constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    // Reproducible vector generated from the fixed private key
    // 0x519b423d715f8b581f4fa8ee59f4771a5b44c8130b4e3eacca54a56dda72b464
    // signing sha256("Legacy Protocol - P256 precompile spike").
    bytes32 constant HASH = 0x0d4850f552f91b54e5e39e5f60de1709b8c5d63bed9fc4ea3711ab020e3249a0;
    uint256 constant R = 0x816ee4bfe21455948312b251fa09a1f7e73962bdc05d0cba5efa21ff728b2477;
    uint256 constant S = 0x2e93f8c385a47dec4de340a1d61a45da58a32be56b77eec10d0ca1bb559dd790;
    uint256 constant X = 0x1ccbe91c075fc7f4f033bfa248db8fccd3565de94bbfb12f3c59ff46c271bf83;
    uint256 constant Y = 0xce4014c68811f9a21a1fdb2c0e6113e06db7ca93b7404e78dc7ccd5ca89a4ca9;

    /// @dev Returns true only when the precompile returns the canonical 32-byte 1.
    function _verify(bytes32 hash, uint256 r, uint256 s, uint256 x, uint256 y) internal view returns (bool) {
        (bool ok, bytes memory out) = P256_VERIFY.staticcall(abi.encodePacked(hash, r, s, x, y));
        // A failed verification is signalled by empty returndata, not by a zero word.
        if (!ok || out.length != 32) return false;
        return abi.decode(out, (uint256)) == 1;
    }

    function test_validSignatureIsAccepted() public view {
        assertTrue(_verify(HASH, R, S, X, Y), "valid P256 signature must verify");
    }

    function test_corruptedRIsRejected() public view {
        assertFalse(_verify(HASH, R ^ 1, S, X, Y), "corrupted r must not verify");
    }

    function test_corruptedSIsRejected() public view {
        assertFalse(_verify(HASH, R, S ^ 1, X, Y), "corrupted s must not verify");
    }

    function test_wrongMessageHashIsRejected() public view {
        assertFalse(_verify(bytes32(uint256(HASH) ^ 1), R, S, X, Y), "wrong digest must not verify");
    }

    function test_wrongPublicKeyIsRejected() public view {
        assertFalse(_verify(HASH, R, S, X ^ 1, Y), "wrong public key must not verify");
    }

    function test_malformedShortInputIsRejected() public view {
        (bool ok, bytes memory out) = P256_VERIFY.staticcall(abi.encodePacked(HASH, R, S, X));
        assertFalse(ok && out.length == 32 && abi.decode(out, (uint256)) == 1, "128-byte input must not verify");
    }

    /// @notice The security-relevant finding: does the precompile enforce low-s?
    /// @dev If (r, n-s) also verifies, every ECDSA signature has a second valid
    ///      form, so `PasskeyVerifierAdapter` MUST reject s > n/2 itself. This
    ///      test records the actual behaviour rather than asserting a guess.
    function test_documentMalleabilityBehaviour() public {
        assertTrue(S <= N / 2, "base vector should be low-s");

        bool highSAccepted = _verify(HASH, R, N - S, X, Y);

        if (highSAccepted) {
            emit log_string("FINDING: high-s accepted -> adapter MUST reject s > n/2 itself");
        } else {
            emit log_string("FINDING: high-s rejected -> precompile enforces low-s");
        }
        emit log_named_uint("high-s accepted (1=yes)", highSAccepted ? 1 : 0);
    }
}
