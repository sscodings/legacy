import {
  type StructuredPolicy,
  type PolicyRule,
  type VaultPolicyContext,
  type IntentCompilationResult,
  type Address,
} from "./types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Deterministic NLP compiler for natural language inheritance instructions.
 * Translates human intent into strongly-typed PolicyRule instances constrained strictly
 * to the vault's registered heirs and assets.
 */
export function compileIntentDeterministic(
  intent: string,
  context: VaultPolicyContext
): IntentCompilationResult {
  const trimmed = intent.trim();
  if (!trimmed) {
    return {
      success: false,
      error: "Please enter your inheritance instructions.",
      suggestions: [
        "Give Alice 50% of USDC immediately and Bob 50% after 90 days",
        "Distribute 100% of my USDC to Bob right away",
      ],
    };
  }

  if (context.heirs.length === 0) {
    return {
      success: false,
      error: "No heirs are registered in this vault. Please add authorized heirs on-chain before designing a policy.",
    };
  }

  if (context.assets.length === 0) {
    return {
      success: false,
      error: "No assets are assigned to this vault. Please add vault assets before designing a policy.",
    };
  }

  // Split into clauses (by comma, semicolon, "and", "then", full stop)
  const clauses = trimmed
    .split(/(?:;|\.|\band\b|\bthen\b)/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 5);

  const matchedRules: PolicyRule[] = [];
  const unmatchedIssues: string[] = [];

  for (const clause of clauses) {
    // 1. Identify Heir
    let matchedHeir: { address: Address; name?: string } | null = null;
    for (const heir of context.heirs) {
      if (heir.name && new RegExp(`\\b${escapeRegex(heir.name)}\\b`, "i").test(clause)) {
        matchedHeir = heir;
        break;
      }
      if (new RegExp(heir.address, "i").test(clause)) {
        matchedHeir = heir;
        break;
      }
      // Check first 6 chars of address
      if (new RegExp(heir.address.slice(0, 6), "i").test(clause)) {
        matchedHeir = heir;
        break;
      }
    }

    // 2. Identify Asset
    let matchedAsset = context.assets[0]; // default to first asset if single asset exists
    let explicitlyMatchedAsset = false;
    for (const asset of context.assets) {
      if (asset.symbol && new RegExp(`\\b${escapeRegex(asset.symbol)}\\b`, "i").test(clause)) {
        matchedAsset = asset;
        explicitlyMatchedAsset = true;
        break;
      }
      if (new RegExp(`\\b${escapeRegex(asset.label)}\\b`, "i").test(clause)) {
        matchedAsset = asset;
        explicitlyMatchedAsset = true;
        break;
      }
    }

    if (!explicitlyMatchedAsset && context.assets.length > 1) {
      // If multiple assets exist and none matched in this clause
      const assetLabels = context.assets.map((a) => a.symbol || a.label).join(", ");
      unmatchedIssues.push(`Could not determine which asset is referenced in "${clause}". Available assets: ${assetLabels}.`);
      continue;
    }

    if (!matchedHeir) {
      const heirLabels = context.heirs.map((h) => h.name || `${h.address.slice(0, 6)}...`).join(", ");
      unmatchedIssues.push(`Could not match any registered heir in "${clause}". Available heirs: ${heirLabels}.`);
      continue;
    }

    // 3. Extract Percentage or Amount
    let percentageBps = 0;
    const percentMatch = clause.match(/(\d+(?:\.\d+)?)\s*%/i) || clause.match(/(\d+(?:\.\d+)?)\s*percent/i);
    if (percentMatch) {
      const pct = parseFloat(percentMatch[1]);
      percentageBps = Math.round(pct * 100);
    } else if (/\bhalf\b/i.test(clause)) {
      percentageBps = 5000;
    } else if (/\b(all|entire|everything|100%)\b/i.test(clause)) {
      percentageBps = 10000;
    } else if (/\bquarter\b/i.test(clause)) {
      percentageBps = 2500;
    } else if (clauses.length === 2 && matchedRules.length === 0) {
      percentageBps = 5000; // default 50% each if 2 clauses without explicit percentages
    } else if (clauses.length === 1) {
      percentageBps = 10000;
    }

    // 4. Extract Release Delay
    let releaseDelaySeconds = 0n;
    const isImmediate = /\b(immediately|right away|now|instantly|instant|immediate|t\+0|0 days)\b/i.test(clause);
    if (!isImmediate) {
      const daysMatch = clause.match(/(\d+)\s*(?:day|days)/i);
      const hoursMatch = clause.match(/(\d+)\s*(?:hour|hours)/i);
      const weeksMatch = clause.match(/(\d+)\s*(?:week|weeks)/i);
      const monthsMatch = clause.match(/(\d+)\s*(?:month|months)/i);

      if (daysMatch) {
        releaseDelaySeconds = BigInt(parseInt(daysMatch[1], 10) * 86400);
      } else if (hoursMatch) {
        releaseDelaySeconds = BigInt(parseInt(hoursMatch[1], 10) * 3600);
      } else if (weeksMatch) {
        releaseDelaySeconds = BigInt(parseInt(weeksMatch[1], 10) * 7 * 86400);
      } else if (monthsMatch) {
        releaseDelaySeconds = BigInt(parseInt(monthsMatch[1], 10) * 30 * 86400);
      }
    }

    // 5. Extract Fallback Beneficiary
    let fallbackBeneficiary = ZERO_ADDRESS;
    let fallbackName: string | undefined;
    const fallbackMatch = clause.match(/(?:fallback|otherwise|or else|if not)\s+(?:to\s+)?([a-z0-9_]+)/i);
    if (fallbackMatch) {
      const targetName = fallbackMatch[1].toLowerCase();
      const fb = context.heirs.find(
        (h) => h.name?.toLowerCase() === targetName || h.address.toLowerCase() === targetName
      );
      if (fb) {
        fallbackBeneficiary = fb.address;
        fallbackName = fb.name;
      }
    }

    matchedRules.push({
      beneficiary: matchedHeir.address,
      beneficiaryName: matchedHeir.name,
      assetId: matchedAsset.assetId,
      assetLabel: matchedAsset.label,
      token: (matchedAsset.token || ZERO_ADDRESS) as Address,
      amount: matchedAsset.amount ? (matchedAsset.amount * BigInt(percentageBps)) / 10000n : 0n,
      percentageBps,
      releaseDelaySeconds,
      fallbackBeneficiary,
      fallbackBeneficiaryName: fallbackName,
    });
  }

  if (unmatchedIssues.length > 0 && matchedRules.length === 0) {
    return {
      success: false,
      error: unmatchedIssues[0],
      suggestions: [
        "Please explicitly specify the heir name and percentage (e.g. 'Give Alice 50% and Bob 50%')",
      ],
    };
  }

  // If two rules were found and percentages sum to 0 or didn't specify, distribute equally
  if (matchedRules.length > 0) {
    const totalBps = matchedRules.reduce((sum, r) => sum + r.percentageBps, 0);
    if (totalBps === 0 && matchedRules.length > 0) {
      const perRuleBps = Math.floor(10000 / matchedRules.length);
      matchedRules.forEach((r, i) => {
        r.percentageBps = i === matchedRules.length - 1 ? 10000 - perRuleBps * (matchedRules.length - 1) : perRuleBps;
      });
    }
  }

  const structuredPolicy: StructuredPolicy = {
    version: 1,
    vault: context.vaultAddress,
    trigger: "TRIGGER_SUCCESSION",
    rules: matchedRules,
  };

  return {
    success: true,
    policy: structuredPolicy,
    explanation: `Successfully compiled into ${matchedRules.length} deterministic rule(s).`,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Universal compiler with optional server-side LLM provider fallback.
 */
export async function compileIntent(
  intent: string,
  context: VaultPolicyContext
): Promise<IntentCompilationResult> {
  // First attempt server-side API if available
  try {
    const res = await fetch("/api/policy/compile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent, context }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success && data.policy) {
        // Hydrate BigInts
        data.policy.rules = data.policy.rules.map((r: PolicyRule) => ({
          ...r,
          amount: BigInt(r.amount || 0),
          releaseDelaySeconds: BigInt(r.releaseDelaySeconds || 0),
        }));
        return data;
      }
    }
  } catch {
    // If API route is unavailable or offline, seamlessly fall back to local deterministic compiler
  }

  return compileIntentDeterministic(intent, context);
}
