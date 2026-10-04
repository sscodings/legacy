// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC721Adapter} from "../src/adapters/ERC721Adapter.sol";
import {LegacyVault} from "../src/LegacyVault.sol";
import {LegacyVaultFactory} from "../src/LegacyVaultFactory.sol";
import {WorldIDVerifierAdapter} from "../src/adapters/WorldIDVerifierAdapter.sol";
import {MockERC721} from "./mocks/MockERC721.sol";
import {MockWorldID} from "./mocks/MockWorldID.sol";

contract ERC721AdapterTest is Test {
    MockERC721 public nft;
    ERC721Adapter public adapter;

    address owner = address(0xA11CE);
    address heir = address(0xBEEF);
    address attacker = address(0xBAD);
    address mockVault = address(0xCAFE);

    uint256 constant TOKEN_ID = 101;

    event NFTOwnershipTransferred(
        address indexed tokenContract, uint256 indexed tokenId, address indexed from, address to
    );

    function setUp() public {
        nft = new MockERC721();
        nft.mint(owner, TOKEN_ID);

        adapter = new ERC721Adapter(address(nft), TOKEN_ID, mockVault);

        // Owner approves adapter for transfer
        vm.prank(owner);
        nft.setApprovalForAll(address(adapter), true);
    }

    // -------------------------------------------------------------------------
    // Adapter Unit Tests
    // -------------------------------------------------------------------------

    function test_constructorStoresConfiguration() public view {
        assertEq(address(adapter.tokenContract()), address(nft));
        assertEq(adapter.tokenId(), TOKEN_ID);
        assertEq(adapter.vault(), mockVault);
    }

    function test_revertWhen_ConstructorWithZeroAddress() public {
        vm.expectRevert(ERC721Adapter.InvalidAddress.selector);
        new ERC721Adapter(address(0), TOKEN_ID, mockVault);

        vm.expectRevert(ERC721Adapter.InvalidAddress.selector);
        new ERC721Adapter(address(nft), TOKEN_ID, address(0));
    }

    function test_constructorAcceptsZeroTokenId() public {
        nft.mint(owner, 0);
        ERC721Adapter zeroAdapter = new ERC721Adapter(address(nft), 0, mockVault);
        assertEq(zeroAdapter.tokenId(), 0);
        assertTrue(zeroAdapter.checkOwnership(owner));
    }

    function test_checkOwnershipReturnsTrueForCurrentOwner() public view {
        assertTrue(adapter.checkOwnership(owner));
    }

    function test_checkOwnershipReturnsFalseForDifferentOwner() public view {
        assertFalse(adapter.checkOwnership(heir));
        assertFalse(adapter.checkOwnership(address(0)));
    }

    function test_checkOwnershipReturnsFalseForBurnedOrNonExistentToken() public {
        ERC721Adapter unmintedAdapter = new ERC721Adapter(address(nft), 9999, mockVault);
        assertFalse(unmintedAdapter.checkOwnership(owner));
    }

    function test_onlyVaultCanTransferControl() public {
        vm.prank(attacker);
        vm.expectRevert(ERC721Adapter.NotVault.selector);
        adapter.transferControl(owner, heir);
    }

    function test_revertWhen_FromIsNotCurrentNFTOwner() public {
        address wrongOwner = address(0x1234);

        vm.prank(mockVault);
        vm.expectRevert(ERC721Adapter.NotCurrentOwner.selector);
        adapter.transferControl(wrongOwner, heir);
    }

    function test_transferControlTransfersNFTOwnership() public {
        vm.expectEmit(true, true, true, true);
        emit NFTOwnershipTransferred(address(nft), TOKEN_ID, owner, heir);

        vm.prank(mockVault);
        adapter.transferControl(owner, heir);

        assertEq(nft.ownerOf(TOKEN_ID), heir);
    }

    // -------------------------------------------------------------------------
    // End-to-End Succession Test: LegacyVault -> ERC721Adapter -> NFT
    // -------------------------------------------------------------------------

    function test_e2e_LegacyVaultTransfersNFTOnSuccession() public {
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

        uint256 realTokenId = 202;
        nft.mint(owner, realTokenId);
        ERC721Adapter genuineAdapter = new ERC721Adapter(address(nft), realTokenId, address(vault));

        vm.prank(owner);
        nft.setApprovalForAll(address(genuineAdapter), true);

        bytes32 assetId = keccak256(abi.encodePacked("NFT_VAULT_ASSET", realTokenId));
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

        // 8. Heir executes claim -> NFT is transferred!
        vm.prank(heir);
        vault.executeClaim(assetId);

        assertEq(nft.ownerOf(realTokenId), heir);
    }
}
