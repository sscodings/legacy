import { type AllocationHealthMap } from "@/lib/allocations";
import {
  type StructuredPolicy,
  type VaultPolicyContext,
  type PolicySimulationResult,
  type PolicySimulationStep,
} from "./types";

export function formatDelayLabel(seconds: bigint): { label: string; offsetLabel: string } {
  if (seconds === 0n) {
    return { label: "Immediately upon succession", offsetLabel: "T+0" };
  }

  const s = Number(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);

  if (days > 0 && hours === 0) {
    return { label: `${days} day${days > 1 ? "s" : ""} after succession`, offsetLabel: `T+${days}d` };
  }
  if (days > 0 && hours > 0) {
    return {
      label: `${days}d ${hours}h after succession`,
      offsetLabel: `T+${days}d ${hours}h`,
    };
  }
  return { label: `${hours} hour${hours > 1 ? "s" : ""} after succession`, offsetLabel: `T+${hours}h` };
}

export function simulatePolicy(
  policy: StructuredPolicy,
  context: VaultPolicyContext,
  healthMap?: AllocationHealthMap
): PolicySimulationResult {
  const heirNameMap = new Map<string, string>();
  for (const h of context.heirs) {
    heirNameMap.set(h.address.toLowerCase(), h.name || `${h.address.slice(0, 6)}...${h.address.slice(-4)}`);
  }

  const assetLabelMap = new Map<string, string>();
  for (const a of context.assets) {
    assetLabelMap.set(a.assetId.toLowerCase(), a.label);
  }

  // Sort rules deterministically by release delay then by heir address
  const sortedRules = [...policy.rules].sort((a, b) => {
    if (a.releaseDelaySeconds !== b.releaseDelaySeconds) {
      return a.releaseDelaySeconds < b.releaseDelaySeconds ? -1 : 1;
    }
    return a.beneficiary.localeCompare(b.beneficiary);
  });

  let totalAllocatedBps = 0;
  let hasBlockedStep = false;
  let hasTimelockedStep = false;

  const steps: PolicySimulationStep[] = sortedRules.map((rule, idx) => {
    const heirName =
      rule.beneficiaryName ||
      heirNameMap.get(rule.beneficiary.toLowerCase()) ||
      `${rule.beneficiary.slice(0, 6)}...${rule.beneficiary.slice(-4)}`;

    const assetLabel = rule.assetLabel || assetLabelMap.get(rule.assetId.toLowerCase()) || "Asset";
    const { label: delayDescription, offsetLabel: timeLabel } = formatDelayLabel(rule.releaseDelaySeconds);

    const health = healthMap ? healthMap[rule.assetId] : undefined;
    const healthState = health ? health.state : "unknown";

    const isImmediate = rule.releaseDelaySeconds === 0n;
    if (!isImmediate) hasTimelockedStep = true;

    let stepStatus: "EXECUTABLE" | "TIMELOCKED" | "BLOCKED" = isImmediate ? "EXECUTABLE" : "TIMELOCKED";

    if (healthState === "short-balance" || healthState === "not-held") {
      stepStatus = "BLOCKED";
      hasBlockedStep = true;
    }

    totalAllocatedBps += rule.percentageBps;

    const percentageLabel =
      rule.percentageBps > 0 ? `${(rule.percentageBps / 100).toFixed(0)}%` : "Fixed allocation";

    const amountLabel =
      rule.amount > 0n
        ? `${rule.amount.toString()} units`
        : percentageLabel;

    return {
      id: `step-${idx}-${rule.beneficiary.slice(0, 8)}`,
      timeOffsetSeconds: rule.releaseDelaySeconds,
      timeLabel,
      heir: rule.beneficiary,
      heirName,
      assetLabel,
      percentageLabel,
      amountLabel,
      executable: stepStatus === "EXECUTABLE",
      healthState,
      status: stepStatus,
      delayDescription,
    };
  });

  let status: "READY" | "BLOCKED" | "TIMELOCKED" = "READY";
  if (hasBlockedStep) {
    status = "BLOCKED";
  } else if (hasTimelockedStep) {
    status = "TIMELOCKED";
  }

  const immediateCount = steps.filter((s) => s.status === "EXECUTABLE").length;
  const delayedCount = steps.filter((s) => s.status === "TIMELOCKED").length;

  const summary = `Simulation complete: ${steps.length} allocation step(s). ${immediateCount} immediate, ${delayedCount} timelocked release(s). Total allocation: ${(totalAllocatedBps / 100).toFixed(0)}%.`;

  return {
    steps,
    totalAllocatedBps,
    status,
    summary,
  };
}
