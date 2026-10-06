import { type AllocationHealthMap } from "@/lib/allocations";
import {
  type PolicyRule,
  type StructuredPolicy,
  type VaultPolicyContext,
  type PolicyValidationResult,
  type PolicyValidationCheck,
} from "./types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function validatePolicy(
  policy: StructuredPolicy,
  context: VaultPolicyContext,
  healthMap?: AllocationHealthMap
): PolicyValidationResult {
  const checks: PolicyValidationCheck[] = [];
  let canCommit = true;
  let blockedReason: string | undefined;

  // 1. Vault ownership check
  if (!context.vaultAddress || context.vaultAddress === ZERO_ADDRESS) {
    checks.push({
      id: "vault-exists",
      title: "Vault Exists",
      passed: false,
      level: "error",
      detail: "No active vault selected.",
    });
    canCommit = false;
    blockedReason = blockedReason ?? "Vault does not exist or is not loaded.";
  } else {
    checks.push({
      id: "vault-exists",
      title: "Vault Verified",
      passed: true,
      level: "success",
      detail: `Vault ${context.vaultAddress.slice(0, 6)}...${context.vaultAddress.slice(-4)} active.`,
    });
  }

  if (!context.isOwnerConnected) {
    checks.push({
      id: "owner-auth",
      title: "Owner Authorization",
      passed: false,
      level: "error",
      detail: "Connected wallet is not the owner of this vault. Only the owner can commit policies.",
    });
    canCommit = false;
    blockedReason = blockedReason ?? "Connected wallet is not the vault owner.";
  } else {
    checks.push({
      id: "owner-auth",
      title: "Vault Owner Verified",
      passed: true,
      level: "success",
      detail: "Connected wallet is verified as the vault owner.",
    });
  }

  // 2. Vault status check (must be Green to modify policy)
  if (context.vaultStatus !== 0) {
    const statusLabel = context.vaultStatus === 1 ? "Amber" : "Red";
    checks.push({
      id: "vault-status-green",
      title: "Vault Status",
      passed: false,
      level: "error",
      detail: `Vault is currently in ${statusLabel} status. Policy modifications are locked while vault is not Green. Check in to restore Green status.`,
    });
    canCommit = false;
    blockedReason = blockedReason ?? `Vault is in ${statusLabel} status. Liveness check-in required.`;
  } else {
    checks.push({
      id: "vault-status-green",
      title: "Vault Status Green",
      passed: true,
      level: "success",
      detail: "Vault is live and Green. Policy updates permitted.",
    });
  }

  // 3. Rules presence
  if (!policy.rules || policy.rules.length === 0) {
    checks.push({
      id: "rules-presence",
      title: "Policy Rules",
      passed: false,
      level: "error",
      detail: "Policy must contain at least one allocation rule.",
    });
    return {
      isValid: false,
      canCommit: false,
      checks,
      blockedReason: "Policy contains no rules.",
    };
  }

  // 4. Beneficiary authorization checks
  const heirAddressSet = new Set(context.heirs.map((h) => h.address.toLowerCase()));
  let allBeneficiariesValid = true;
  const invalidBeneficiaries: string[] = [];

  for (const rule of policy.rules) {
    if (!rule.beneficiary || rule.beneficiary === ZERO_ADDRESS) {
      allBeneficiariesValid = false;
      invalidBeneficiaries.push("Zero address");
      continue;
    }
    if (rule.beneficiary.toLowerCase() === context.ownerAddress?.toLowerCase()) {
      allBeneficiariesValid = false;
      invalidBeneficiaries.push("Owner cannot be beneficiary of own vault");
      continue;
    }
    if (!heirAddressSet.has(rule.beneficiary.toLowerCase())) {
      allBeneficiariesValid = false;
      invalidBeneficiaries.push(rule.beneficiaryName || rule.beneficiary);
    }

    if (rule.fallbackBeneficiary && rule.fallbackBeneficiary !== ZERO_ADDRESS) {
      if (!heirAddressSet.has(rule.fallbackBeneficiary.toLowerCase())) {
        allBeneficiariesValid = false;
        invalidBeneficiaries.push(`Fallback: ${rule.fallbackBeneficiaryName || rule.fallbackBeneficiary}`);
      }
    }
  }

  if (!allBeneficiariesValid) {
    checks.push({
      id: "heir-registration",
      title: "Beneficiary Authorization",
      passed: false,
      level: "error",
      detail: `One or more beneficiaries are not registered heirs on-chain: ${invalidBeneficiaries.join(", ")}. Please add them as heirs in the vault first.`,
    });
    canCommit = false;
    blockedReason = blockedReason ?? "Beneficiaries must be registered on-chain heirs.";
  } else {
    checks.push({
      id: "heir-registration",
      title: "All Beneficiaries Registered",
      passed: true,
      level: "success",
      detail: `All ${policy.rules.length} rule beneficiaries are authorized heirs.`,
    });
  }

  // 5. Allocation percentage and amount checks per asset
  const rulesByAsset: Record<string, PolicyRule[]> = {};
  for (const rule of policy.rules) {
    const key = (rule.assetId || rule.token || "default").toLowerCase();
    if (!rulesByAsset[key]) rulesByAsset[key] = [];
    rulesByAsset[key].push(rule);
  }

  let totalPercentageValid = true;
  for (const [assetKey, assetRules] of Object.entries(rulesByAsset)) {
    const hasPercentages = assetRules.some((r) => r.percentageBps > 0);
    if (hasPercentages) {
      const sumBps = assetRules.reduce((acc, r) => acc + r.percentageBps, 0);
      if (sumBps !== 10000) {
        totalPercentageValid = false;
        checks.push({
          id: `allocation-sum-${assetKey}`,
          title: "Percentage Distribution",
          passed: false,
          level: "error",
          detail: `Allocations for asset must total exactly 100%. Current sum: ${(sumBps / 100).toFixed(1)}%.`,
        });
        canCommit = false;
        blockedReason = blockedReason ?? `Allocation total is ${(sumBps / 100).toFixed(1)}%, must be exactly 100%.`;
      }
    } else {
      // Fixed amount rules: verify amount > 0
      for (const r of assetRules) {
        if (r.amount <= 0n) {
          checks.push({
            id: `rule-amount-${r.assetId}`,
            title: "Rule Amount",
            passed: false,
            level: "error",
            detail: "Fixed allocation amount must be greater than zero.",
          });
          canCommit = false;
          blockedReason = blockedReason ?? "Rule amount must be greater than zero.";
        }
      }
    }
  }

  if (totalPercentageValid) {
    checks.push({
      id: "allocation-sum-valid",
      title: "Allocation Total Valid",
      passed: true,
      level: "success",
      detail: "Asset allocations total exactly 100% of defined pool.",
    });
  }

  // 6. Asset Health integration
  if (healthMap) {
    let allAssetsBacked = true;
    const healthIssues: string[] = [];

    for (const rule of policy.rules) {
      const health = healthMap[rule.assetId];
      if (health) {
        if (health.state === "short-balance") {
          allAssetsBacked = false;
          healthIssues.push(`${rule.assetLabel || "Asset"}: Insufficient owner wallet balance`);
        } else if (health.state === "missing-approval") {
          allAssetsBacked = false;
          healthIssues.push(`${rule.assetLabel || "Asset"}: Adapter allowance missing or insufficient`);
        } else if (health.state === "not-held") {
          allAssetsBacked = false;
          healthIssues.push(`${rule.assetLabel || "Asset"}: Owner no longer holds this asset`);
        }
      }
    }

    if (!allAssetsBacked) {
      checks.push({
        id: "asset-health",
        title: "Underlying Asset Backing",
        passed: false,
        level: "warning",
        detail: `Underlying asset health check flagged issues: ${healthIssues.join("; ")}. Please ensure balances and approvals are current.`,
      });
      // Warning does not necessarily prevent committing the future policy intent, but alerts the user clearly
    } else {
      checks.push({
        id: "asset-health",
        title: "Asset Health Backed",
        passed: true,
        level: "success",
        detail: "All underlying assets are funded and approved in wallet.",
      });
    }
  }

  // 7. Release timing schedule check
  const delayedRules = policy.rules.filter((r) => r.releaseDelaySeconds > 0n);
  const immediateRules = policy.rules.filter((r) => r.releaseDelaySeconds === 0n);

  checks.push({
    id: "release-schedule",
    title: "Release Schedule Valid",
    passed: true,
    level: "success",
    detail: `${immediateRules.length} immediate release(s), ${delayedRules.length} delayed release(s) scheduled.`,
  });

  return {
    isValid: canCommit,
    canCommit,
    checks,
    blockedReason,
  };
}
