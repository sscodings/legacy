// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IVaultExecutor} from "../../src/interfaces/IVaultExecutor.sol";
import {LegacyVault} from "../../src/LegacyVault.sol";

enum ReentrancyTarget {
    None,
    ExecuteSameAsset,
    ExecuteOtherAsset,
    FinalizeClaim,
    InitiateClaim,
    CheckIn,
    AddHeir,
    AssignAsset
}

contract MaliciousReentrantExecutor is IVaultExecutor {
    LegacyVault public vault;
    bytes32 public targetAssetId;
    bytes32 public secondaryAssetId;
    address public heirTarget;
    ReentrancyTarget public attackTarget;

    bool public attackAttempted;
    bool public attackSucceeded;
    bytes public revertReason;

    constructor(LegacyVault _vault) {
        vault = _vault;
    }

    function setAttack(ReentrancyTarget _target, bytes32 _targetAssetId, bytes32 _secondaryAssetId, address _heirTarget)
        external
    {
        attackTarget = _target;
        targetAssetId = _targetAssetId;
        secondaryAssetId = _secondaryAssetId;
        heirTarget = _heirTarget;
        attackAttempted = false;
        attackSucceeded = false;
        revertReason = "";
    }

    function checkOwnership(address) external pure override returns (bool) {
        return true;
    }

    function transferControl(address, address) external override {
        if (attackTarget == ReentrancyTarget.None) {
            return;
        }

        attackAttempted = true;

        if (attackTarget == ReentrancyTarget.ExecuteSameAsset) {
            // Attempt to reenter executeClaim with the exact same asset
            try vault.executeClaim(targetAssetId) {
                attackSucceeded = true;
            } catch (bytes memory reason) {
                revertReason = reason;
            }
        } else if (attackTarget == ReentrancyTarget.ExecuteOtherAsset) {
            // Attempt to reenter executeClaim with another asset
            try vault.executeClaim(secondaryAssetId) {
                attackSucceeded = true;
            } catch (bytes memory reason) {
                revertReason = reason;
            }
        } else if (attackTarget == ReentrancyTarget.FinalizeClaim) {
            // Attempt to reenter finalizeClaim
            try vault.finalizeClaim() {
                attackSucceeded = true;
            } catch (bytes memory reason) {
                revertReason = reason;
            }
        } else if (attackTarget == ReentrancyTarget.InitiateClaim) {
            // Attempt to reenter initiateClaim
            try vault.initiateClaim() {
                attackSucceeded = true;
            } catch (bytes memory reason) {
                revertReason = reason;
            }
        } else if (attackTarget == ReentrancyTarget.CheckIn) {
            // Attempt to reenter checkIn
            uint256[8] memory proof;
            try vault.checkIn(abi.encode(1, 42, proof)) {
                attackSucceeded = true;
            } catch (bytes memory reason) {
                revertReason = reason;
            }
        } else if (attackTarget == ReentrancyTarget.AddHeir) {
            // Attempt to reenter addHeir
            try vault.addHeir(address(0x9999)) {
                attackSucceeded = true;
            } catch (bytes memory reason) {
                revertReason = reason;
            }
        } else if (attackTarget == ReentrancyTarget.AssignAsset) {
            // Attempt to reenter assignAsset
            try vault.assignAsset(bytes32("EVIL"), heirTarget, this) {
                attackSucceeded = true;
            } catch (bytes memory reason) {
                revertReason = reason;
            }
        }
    }
}
