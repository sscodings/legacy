"use client";

import { useState, useEffect, useCallback } from "react";
import { type Hex } from "viem";
import { useReadContract } from "wagmi";
import { CONTRACT_ADDRESSES } from "@/lib/constants";
import { LegacyPolicyEngineABI } from "@/lib/contracts/abis";
import { type StructuredPolicy, type PolicyRule, type Address } from "@/lib/policy/types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export function usePolicyEngine(vaultAddress?: Address) {
  const [localPolicy, setLocalPolicy] = useState<StructuredPolicy | null>(null);

  const policyEngineAddress = (CONTRACT_ADDRESSES.policyEngine || ZERO_ADDRESS) as Address;
  const isEngineAvailable = Boolean(
    vaultAddress &&
      policyEngineAddress &&
      policyEngineAddress !== ZERO_ADDRESS
  );

  const {
    data: activeCommitment,
    isLoading: isCommitmentLoading,
    refetch: refetchCommitment,
  } = useReadContract({
    address: policyEngineAddress,
    abi: LegacyPolicyEngineABI,
    functionName: "getActivePolicy",
    args: vaultAddress ? [vaultAddress] : undefined,
    query: {
      enabled: isEngineAvailable,
    },
  });

  const version = activeCommitment ? Number(activeCommitment.version) : localPolicy?.version || 0;
  const policyHash = activeCommitment && activeCommitment.exists
    ? (activeCommitment.policyHash as Hex)
    : localPolicy?.policyHash || null;

  const {
    data: onChainRules,
    isLoading: isRulesLoading,
    refetch: refetchRules,
  } = useReadContract({
    address: policyEngineAddress,
    abi: LegacyPolicyEngineABI,
    functionName: "getPolicyRules",
    args: vaultAddress && version > 0 ? [vaultAddress, BigInt(version)] : undefined,
    query: {
      enabled: isEngineAvailable && version > 0,
    },
  });

  // Load local cache if available for friendly names
  useEffect(() => {
    if (!vaultAddress) return;
    try {
      const stored = localStorage.getItem(`legacy_policy_${vaultAddress.toLowerCase()}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && Array.isArray(parsed.rules)) {
          parsed.rules = parsed.rules.map((r: PolicyRule) => ({
            ...r,
            amount: BigInt(r.amount || 0),
            releaseDelaySeconds: BigInt(r.releaseDelaySeconds || 0),
          }));
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setLocalPolicy(parsed);
        }
      }
    } catch {
      // Ignore localStorage errors
    }
  }, [vaultAddress]);

  const savePolicyLocally = useCallback(
    (newPolicy: StructuredPolicy) => {
      if (!vaultAddress) return;
      try {
        const serialized = {
          ...newPolicy,
          rules: newPolicy.rules.map((r) => ({
            ...r,
            amount: r.amount.toString(),
            releaseDelaySeconds: r.releaseDelaySeconds.toString(),
          })),
        };
        localStorage.setItem(`legacy_policy_${vaultAddress.toLowerCase()}`, JSON.stringify(serialized));
        setLocalPolicy(newPolicy);
      } catch {
        // Ignore localStorage errors
      }
    },
    [vaultAddress]
  );

  const rules: PolicyRule[] = onChainRules
    ? onChainRules.map((r, i) => {
        const local = localPolicy?.rules[i];
        return {
          beneficiary: r.beneficiary as Address,
          assetId: r.assetId as Hex,
          token: r.token as Address,
          amount: BigInt(r.amount.toString()),
          percentageBps: Number(r.percentageBps),
          releaseDelaySeconds: BigInt(r.releaseDelaySeconds.toString()),
          fallbackBeneficiary: r.fallbackBeneficiary as Address,
          beneficiaryName: local?.beneficiaryName,
          fallbackBeneficiaryName: local?.fallbackBeneficiaryName,
          assetLabel: local?.assetLabel,
        };
      })
    : localPolicy?.rules || [];

  const refetch = useCallback(() => {
    if (isEngineAvailable) {
      refetchCommitment();
      refetchRules();
    }
  }, [isEngineAvailable, refetchCommitment, refetchRules]);

  return {
    policyVersion: version,
    policyHash,
    rules,
    activePolicy: localPolicy,
    isLoading: isCommitmentLoading || isRulesLoading,
    savePolicyLocally,
    refetch,
  };
}
