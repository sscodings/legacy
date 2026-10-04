// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployMonadScript} from "../script/DeployMonad.s.sol";
import {LegacyVault} from "../src/LegacyVault.sol";
import {LegacyVaultFactory} from "../src/LegacyVaultFactory.sol";
import {PasskeyVerifierAdapter} from "../src/adapters/PasskeyVerifierAdapter.sol";

contract DeployMonadTest is Test {
    DeployMonadScript public script;

    function setUp() public {
        script = new DeployMonadScript();
    }

    function test_DeploymentScriptWiresPasskeyVerifier() public {
        DeployMonadScript.Deployment memory deployment = script.run();

        assertTrue(deployment.implementation.code.length > 0);
        assertTrue(deployment.factory.code.length > 0);
        assertTrue(deployment.verifierAdapter.code.length > 0);

        LegacyVaultFactory factory = LegacyVaultFactory(deployment.factory);
        assertEq(factory.implementation(), deployment.implementation);

        address owner = address(0xA11CE);
        vm.prank(owner);
        LegacyVault vault = LegacyVault(
            factory.createVault(PasskeyVerifierAdapter(deployment.verifierAdapter), 30 days, 7 days, 3 days)
        );

        assertEq(vault.owner(), owner);
        assertEq(address(vault.verifier()), deployment.verifierAdapter);
        assertFalse(vault.livenessRegistered());
        assertEq(vault.livenessNonce(), 0);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Green));
    }
}
