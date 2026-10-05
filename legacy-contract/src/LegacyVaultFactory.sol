// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {LegacyVault} from "./LegacyVault.sol";
import {ILivenessVerifier} from "./interfaces/ILivenessVerifier.sol";

contract LegacyVaultFactory {
    using Clones for address;

    address public immutable implementation;

    mapping(address => address[]) private vaultsByOwner;

    event VaultCreated(address indexed owner, address indexed vault);

    error InvalidImplementation();

    constructor(address _implementation) {
        if (_implementation == address(0)) revert InvalidImplementation();
        implementation = _implementation;
    }

    function createVault(
        ILivenessVerifier verifier,
        uint256 checkInInterval,
        uint256 gracePeriod,
        uint256 contestableWindow
    ) external returns (address vault) {
        vault = implementation.clone();

        LegacyVault(vault).initialize(msg.sender, verifier, checkInInterval, gracePeriod, contestableWindow);

        vaultsByOwner[msg.sender].push(vault);

        emit VaultCreated(msg.sender, vault);
    }

    function getVaults(address account) external view returns (address[] memory) {
        return vaultsByOwner[account];
    }
}
