import {
  keccak256,
  stringToBytes,
  encodeAbiParameters,
  parseAbiParameters,
  concat,
  type Hex,
} from "viem";
import { type Address, type PolicyRule } from "./types";

export const TRIGGER_SUCCESSION: Hex = keccak256(stringToBytes("TRIGGER_SUCCESSION"));

export const RULE_TYPEHASH: Hex = keccak256(
  stringToBytes(
    "PolicyRule(address beneficiary,bytes32 assetId,address token,uint256 amount,uint256 percentageBps,uint256 releaseDelaySeconds,address fallbackBeneficiary)"
  )
);

export const POLICY_TYPEHASH: Hex = keccak256(
  stringToBytes("Policy(address vault,uint256 version,bytes32 trigger,PolicyRule[] rules)")
);

export const DOMAIN_TYPEHASH: Hex = keccak256(
  stringToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
);

export const DOMAIN_NAME_HASH: Hex = keccak256(stringToBytes("LegacyPolicyEngine"));
export const DOMAIN_VERSION_HASH: Hex = keccak256(stringToBytes("1"));

export function computeDomainSeparator(chainId: number, verifyingContract: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"),
      [
        DOMAIN_TYPEHASH,
        DOMAIN_NAME_HASH,
        DOMAIN_VERSION_HASH,
        BigInt(chainId),
        verifyingContract,
      ]
    )
  );
}

export function hashPolicyRule(rule: PolicyRule): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, address, bytes32, address, uint256, uint256, uint256, address"),
      [
        RULE_TYPEHASH,
        rule.beneficiary,
        rule.assetId,
        rule.token,
        rule.amount,
        BigInt(rule.percentageBps),
        rule.releaseDelaySeconds,
        rule.fallbackBeneficiary,
      ]
    )
  );
}

export function computePolicyHash(
  vault: Address,
  version: number,
  chainId: number,
  verifyingContract: Address,
  rules: PolicyRule[]
): Hex {
  const domainSep = computeDomainSeparator(chainId, verifyingContract);
  const ruleHashes = rules.map(hashPolicyRule);
  const rulesContentHash = keccak256(concat(ruleHashes));

  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, bytes32, address, uint256, bytes32, bytes32"),
      [
        domainSep,
        POLICY_TYPEHASH,
        vault,
        BigInt(version),
        TRIGGER_SUCCESSION,
        rulesContentHash,
      ]
    )
  );
}
