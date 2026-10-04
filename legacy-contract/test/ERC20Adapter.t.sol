// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20Adapter} from "../src/adapters/ERC20Adapter.sol";
import {LegacyVault} from "../src/LegacyVault.sol";
import {LegacyVaultFactory} from "../src/LegacyVaultFactory.sol";
import {WorldIDVerifierAdapter} from "../src/adapters/WorldIDVerifierAdapter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockWorldID} from "./mocks/MockWorldID.sol";

contract ERC20AdapterTest is Test {
    MockERC20 public token;
    ERC20Adapter public adapter;

    address owner = address(0xA11CE);
    address heir = address(0xBEEF);
    address attacker = address(0xBAD);
    address mockVault = address(0xCAFE);

    uint256 constant ALLOCATION_AMOUNT = 1000 ether;

    event TokenTransferred(address indexed token, address indexed from, address indexed to, uint256 amount);

    function setUp() public {
        token = new MockERC20();
        token.mint(owner, 5000 ether);

        adapter = new ERC20Adapter(address(token), ALLOCATION_AMOUNT, mockVault);

        // Owner approves adapter
        vm.prank(owner);
        token.approve(address(adapter), ALLOCATION_AMOUNT);
    }

    // -------------------------------------------------------------------------
    // Adapter Unit Tests
    // -------------------------------------------------------------------------

    function test_constructorStoresConfiguration() public view {
        assertEq(address(adapter.token()), address(token));
        assertEq(adapter.amount(), ALLOCATION_AMOUNT);
        assertEq(adapter.vault(), mockVault);
    }

    function test_revertWhen_ConstructorWithZeroAddress() public {
        vm.expectRevert(ERC20Adapter.InvalidAddress.selector);
        new ERC20Adapter(address(0), ALLOCATION_AMOUNT, mockVault);

        vm.expectRevert(ERC20Adapter.InvalidAddress.selector);
        new ERC20Adapter(address(token), ALLOCATION_AMOUNT, address(0));
    }

    function test_revertWhen_ConstructorWithZeroAmount() public {
        vm.expectRevert(ERC20Adapter.InvalidAmount.selector);
        new ERC20Adapter(address(token), 0, mockVault);
    }

    function test_checkOwnershipReturnsTrueWhenBalanceAndAllowanceSufficient() public view {
        assertTrue(adapter.checkOwnership(owner));
    }

    function test_checkOwnershipReturnsFalseWhenInsufficientBalance() public {
        // Drain owner balance below allocation
        vm.prank(owner);
        token.transfer(attacker, 4500 ether); // remaining: 500 ether < 1000 ether
        assertFalse(adapter.checkOwnership(owner));
    }

    function test_checkOwnershipReturnsFalseWhenInsufficientAllowance() public {
        // Lower allowance below allocation
        vm.prank(owner);
        token.approve(address(adapter), ALLOCATION_AMOUNT - 1);
        assertFalse(adapter.checkOwnership(owner));
    }

    function test_onlyVaultCanTransferControl() public {
        vm.prank(attacker);
        vm.expectRevert(ERC20Adapter.NotVault.selector);
        adapter.transferControl(owner, heir);
    }

    function test_revertWhen_FromHasInsufficientBalance() public {
        // Drain owner balance
        vm.prank(owner);
        token.transfer(attacker, 4500 ether);

        vm.prank(mockVault);
        vm.expectRevert(ERC20Adapter.InsufficientBalance.selector);
        adapter.transferControl(owner, heir);
    }

    function test_revertWhen_FromHasInsufficientAllowance() public {
        vm.prank(owner);
        token.approve(address(adapter), ALLOCATION_AMOUNT - 1);

        vm.prank(mockVault);
        vm.expectRevert(ERC20Adapter.InsufficientAllowance.selector);
        adapter.transferControl(owner, heir);
    }

    function test_transferControlSuccess() public {
        vm.expectEmit(true, true, true, true);
        emit TokenTransferred(address(token), owner, heir, ALLOCATION_AMOUNT);

        vm.prank(mockVault);
        adapter.transferControl(owner, heir);

        assertEq(token.balanceOf(heir), ALLOCATION_AMOUNT);
        assertEq(token.balanceOf(owner), 4000 ether);
    }

    // -------------------------------------------------------------------------
    // End-to-End Succession Test: LegacyVault -> ERC20Adapter -> ERC20 Token
    // -------------------------------------------------------------------------

    function test_e2e_LegacyVaultTransfersERC20OnSuccession() public {
        MockWorldID mockWorldId = new MockWorldID();
        WorldIDVerifierAdapter verifier = new WorldIDVerifierAdapter(mockWorldId, 1, 12345);

        LegacyVault implementation = new LegacyVault();
        LegacyVaultFactory factory = new LegacyVaultFactory(address(implementation));

        uint256 checkInInterval = 30 days;
        uint256 gracePeriod = 7 days;
        uint256 contestableWindow = 3 days;

        vm.prank(owner);
        LegacyVault vault = LegacyVault(factory.createVault(verifier, checkInInterval, gracePeriod, contestableWindow));

        uint256 dummyRoot = 1;
        uint256 dummyNullifier = 42;
        uint256[8] memory dummyProof = [uint256(0), 0, 0, 0, 0, 0, 0, 0];

        vm.prank(owner);
        vault.registerLiveness(abi.encode(dummyRoot, dummyNullifier, dummyProof));

        uint256 vaultAmount = 2500 ether;
        ERC20Adapter genuineAdapter = new ERC20Adapter(address(token), vaultAmount, address(vault));

        vm.prank(owner);
        token.approve(address(genuineAdapter), vaultAmount);

        bytes32 assetId = keccak256("USDC_ALLOCATION_HEIR");
        vm.startPrank(owner);
        vault.addHeir(heir);
        vault.assignAsset(assetId, heir, genuineAdapter);
        vm.stopPrank();

        // 4. Time warps past checkInInterval + gracePeriod -> Vault is Red
        vm.warp(block.timestamp + checkInInterval + gracePeriod);
        assertEq(uint256(vault.getStatus()), uint256(LegacyVault.Status.Red));

        // 5. Heir initiates claim
        vm.prank(heir);
        vault.initiateClaim();

        // 6. Contestable window elapses with no owner check-in
        vm.warp(block.timestamp + contestableWindow);

        // 7. Heir finalizes claim
        vm.prank(heir);
        vault.finalizeClaim();

        // 8. Heir executes claim -> Tokens transferred!
        vm.prank(heir);
        vault.executeClaim(assetId);

        assertEq(token.balanceOf(heir), vaultAmount);
        assertEq(token.balanceOf(owner), 2500 ether);
    }
}
