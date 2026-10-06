// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILegacyPolicyEngine {
    struct PolicyRule {
        address beneficiary;
        bytes32 assetId;
        address token;
        uint256 amount;
        uint256 percentageBps; // 10000 = 100%
        uint256 releaseDelaySeconds;
        address fallbackBeneficiary;
    }

    struct PolicyCommitment {
        uint256 version;
        bytes32 policyHash;
        uint256 committedAt;
        uint256 ruleCount;
        bool exists;
    }

    event PolicyCommitted(
        address indexed vault,
        uint256 indexed version,
        bytes32 indexed policyHash,
        address committedBy,
        uint256 ruleCount,
        uint256 timestamp
    );

    function commitPolicy(address vault, bytes32 policyHash, PolicyRule[] calldata rules)
        external
        returns (uint256 version);

    function computePolicyHash(address vault, uint256 version, bytes32 trigger, PolicyRule[] memory rules)
        external
        view
        returns (bytes32);

    function getActivePolicy(address vault) external view returns (PolicyCommitment memory);

    function getPolicyRule(address vault, uint256 version, uint256 index)
        external
        view
        returns (PolicyRule memory);

    function getPolicyRules(address vault, uint256 version) external view returns (PolicyRule[] memory);

    function isRuleExecutable(address vault, uint256 ruleIndex)
        external
        view
        returns (bool executable, uint256 releaseTime);
}
