// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILegacyPolicyEngine} from "./interfaces/ILegacyPolicyEngine.sol";

interface ILegacyVaultForPolicy {
    enum Status {
        Green,
        Amber,
        Red
    }

    enum ClaimStatus {
        NotInitiated,
        Contestable,
        Claimed
    }

    function owner() external view returns (address);
    function getStatus() external view returns (Status);
    function isHeir(address heir) external view returns (bool);
    function claimStatus(address heir) external view returns (ClaimStatus);
    function claimInitiatedAt(address heir) external view returns (uint256);
    function contestableWindow() external view returns (uint256);
}

/// @title LegacyPolicyEngine
/// @notice Programmable inheritance policy commitment and deterministic execution rules.
contract LegacyPolicyEngine is ILegacyPolicyEngine {
    bytes32 public constant TRIGGER_SUCCESSION = keccak256("TRIGGER_SUCCESSION");
    bytes32 public constant RULE_TYPEHASH = keccak256(
        "PolicyRule(address beneficiary,bytes32 assetId,address token,uint256 amount,uint256 percentageBps,uint256 releaseDelaySeconds,address fallbackBeneficiary)"
    );
    bytes32 public constant POLICY_TYPEHASH = keccak256(
        "Policy(address vault,uint256 version,bytes32 trigger,PolicyRule[] rules)"
    );

    error InvalidVault();
    error NotVaultOwner();
    error VaultNotGreen();
    error InvalidPolicyHash();
    error EmptyRules();
    error InvalidBeneficiary();
    error BeneficiaryNotHeir();
    error FallbackBeneficiaryNotHeir();
    error PolicyHashMismatch(bytes32 provided, bytes32 expected);

    // vault => latest active commitment
    mapping(address vault => PolicyCommitment) public activePolicies;

    // vault => version => commitment
    mapping(address vault => mapping(uint256 version => PolicyCommitment)) public policyHistory;

    // vault => version => ruleIndex => PolicyRule
    mapping(address vault => mapping(uint256 version => mapping(uint256 ruleIndex => PolicyRule))) private _rules;

    // vault => latest version number
    mapping(address vault => uint256) public latestVersion;

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("LegacyPolicyEngine")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /**
     * @notice Computes deterministic canonical policy hash for a given vault, version, trigger, and rules.
     */
    function computePolicyHash(address vault, uint256 version, bytes32 trigger, PolicyRule[] memory rules)
        public
        view
        override
        returns (bytes32)
    {
        bytes32[] memory ruleHashes = new bytes32[](rules.length);
        for (uint256 i = 0; i < rules.length; i++) {
            ruleHashes[i] = keccak256(
                abi.encode(
                    RULE_TYPEHASH,
                    rules[i].beneficiary,
                    rules[i].assetId,
                    rules[i].token,
                    rules[i].amount,
                    rules[i].percentageBps,
                    rules[i].releaseDelaySeconds,
                    rules[i].fallbackBeneficiary
                )
            );
        }

        bytes32 rulesContentHash = keccak256(abi.encodePacked(ruleHashes));

        return keccak256(
            abi.encode(
                domainSeparator(),
                POLICY_TYPEHASH,
                vault,
                version,
                trigger,
                rulesContentHash
            )
        );
    }

    /**
     * @notice Cryptographically commits an owner-approved structured policy.
     * @param vault The target LegacyVault address.
     * @param policyHash Deterministic canonical hash of the policy.
     * @param rules The structured rules making up this policy.
     */
    function commitPolicy(address vault, bytes32 policyHash, PolicyRule[] calldata rules)
        external
        override
        returns (uint256 version)
    {
        if (vault == address(0)) revert InvalidVault();

        ILegacyVaultForPolicy targetVault = ILegacyVaultForPolicy(vault);

        if (msg.sender != targetVault.owner()) revert NotVaultOwner();
        if (targetVault.getStatus() != ILegacyVaultForPolicy.Status.Green) revert VaultNotGreen();
        if (policyHash == bytes32(0)) revert InvalidPolicyHash();
        if (rules.length == 0) revert EmptyRules();

        uint256 newVersion = latestVersion[vault] + 1;

        // Verify that the provided hash exactly matches the canonical computation
        bytes32 expectedHash = computePolicyHash(vault, newVersion, TRIGGER_SUCCESSION, rules);
        if (policyHash != expectedHash) {
            revert PolicyHashMismatch(policyHash, expectedHash);
        }

        // Validate each rule against vault heir authorization
        for (uint256 i = 0; i < rules.length; i++) {
            address ben = rules[i].beneficiary;
            if (ben == address(0)) revert InvalidBeneficiary();
            if (!targetVault.isHeir(ben)) revert BeneficiaryNotHeir();

            address fb = rules[i].fallbackBeneficiary;
            if (fb != address(0) && !targetVault.isHeir(fb)) {
                revert FallbackBeneficiaryNotHeir();
            }
        }

        latestVersion[vault] = newVersion;

        PolicyCommitment memory commitment = PolicyCommitment({
            version: newVersion,
            policyHash: policyHash,
            committedAt: block.timestamp,
            ruleCount: rules.length,
            exists: true
        });

        activePolicies[vault] = commitment;
        policyHistory[vault][newVersion] = commitment;

        for (uint256 i = 0; i < rules.length; i++) {
            _rules[vault][newVersion][i] = rules[i];
        }

        emit PolicyCommitted(
            vault,
            newVersion,
            policyHash,
            msg.sender,
            rules.length,
            block.timestamp
        );

        return newVersion;
    }

    function getActivePolicy(address vault) external view override returns (PolicyCommitment memory) {
        return activePolicies[vault];
    }

    function getPolicyRule(address vault, uint256 version, uint256 index)
        external
        view
        override
        returns (PolicyRule memory)
    {
        return _rules[vault][version][index];
    }

    function getPolicyRules(address vault, uint256 version)
        external
        view
        override
        returns (PolicyRule[] memory)
    {
        PolicyCommitment memory commitment = policyHistory[vault][version];
        if (!commitment.exists) {
            return new PolicyRule[](0);
        }

        PolicyRule[] memory result = new PolicyRule[](commitment.ruleCount);
        for (uint256 i = 0; i < commitment.ruleCount; i++) {
            result[i] = _rules[vault][version][i];
        }
        return result;
    }

    /**
     * @notice Simulates and verifies whether a policy rule is executable based on live vault state.
     */
    function isRuleExecutable(address vault, uint256 ruleIndex)
        external
        view
        override
        returns (bool executable, uint256 releaseTime)
    {
        PolicyCommitment memory active = activePolicies[vault];
        if (!active.exists || ruleIndex >= active.ruleCount) {
            return (false, 0);
        }

        PolicyRule memory rule = _rules[vault][active.version][ruleIndex];
        ILegacyVaultForPolicy targetVault = ILegacyVaultForPolicy(vault);

        if (targetVault.claimStatus(rule.beneficiary) != ILegacyVaultForPolicy.ClaimStatus.Claimed) {
            return (false, 0);
        }

        uint256 initiatedAt = targetVault.claimInitiatedAt(rule.beneficiary);
        uint256 contestable = targetVault.contestableWindow();
        releaseTime = initiatedAt + contestable + rule.releaseDelaySeconds;

        return (block.timestamp >= releaseTime, releaseTime);
    }
}
