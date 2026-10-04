"use client";

import React from "react";
import { formatUnits } from "viem";
import type { AllocationHealth, AllocationReadiness, VaultAllocation } from "@/lib/allocations";

/** Whose eyes the copy is written for. */
export type HealthPerspective = "owner" | "heir" | "public";

type Tone = "ok" | "warn" | "bad" | "muted";

const TONES: Record<Tone, { color: string; background: string }> = {
  ok: { color: "var(--status-green)", background: "rgba(76, 175, 109, 0.14)" },
  warn: { color: "var(--status-amber)", background: "rgba(217, 154, 61, 0.16)" },
  bad: { color: "var(--status-red)", background: "rgba(193, 80, 63, 0.16)" },
  muted: { color: "var(--text-secondary)", background: "rgba(154, 158, 152, 0.2)" },
};

interface HealthCopy {
  tone: Tone;
  label: string;
  detail: string;
}

function possessive(perspective: HealthPerspective): string {
  return perspective === "owner" ? "Your wallet" : "The owner's wallet";
}

export function describeHealth(
  allocation: VaultAllocation,
  health: AllocationHealth | undefined,
  perspective: HealthPerspective
): HealthCopy {
  if (allocation.executed) {
    return { tone: "muted", label: "Claimed", detail: "Transferred to the heir." };
  }
  if (!health) {
    return { tone: "muted", label: "Checking…", detail: "Reading the owner's wallet." };
  }

  switch (health.state) {
    case "backed":
      return { tone: "ok", label: "Backed", detail: "Would transfer in full if claimed today." };

    case "short-balance": {
      const asset = allocation.asset;
      const held =
        asset.kind === "ERC20" && health.balance !== undefined
          ? `${formatUnits(health.balance, asset.decimals)} of ${formatUnits(asset.amount, asset.decimals)} ${asset.symbol}`
          : "less than the allocated amount";
      return { tone: "bad", label: "Underfunded", detail: `${possessive(perspective)} holds ${held}.` };
    }

    case "missing-approval":
      return {
        tone: "warn",
        label: "Approval missing",
        detail:
          perspective === "owner"
            ? "The vault is no longer allowed to move this. Re-approve to fix."
            : "The vault is no longer allowed to move this until the owner re-approves it.",
      };

    case "not-held":
      return {
        tone: "bad",
        label: "Not held",
        detail: `${possessive(perspective)} no longer holds this asset.`,
      };

    case "claimed":
      return { tone: "muted", label: "Claimed", detail: "Transferred to the heir." };

    default:
      return { tone: "muted", label: "Unverified", detail: "This allocation could not be checked." };
  }
}

interface BadgeProps {
  allocation: VaultAllocation;
  health: AllocationHealth | undefined;
  perspective: HealthPerspective;
  /** Shown for the owner when re-approving would fix the allocation. */
  onRestoreApproval?: () => void;
  isRestoring?: boolean;
}

export function AllocationHealthBadge({ allocation, health, perspective, onRestoreApproval, isRestoring }: BadgeProps) {
  const copy = describeHealth(allocation, health, perspective);
  const tone = TONES[copy.tone];
  const canRestore =
    perspective === "owner" &&
    health?.state === "missing-approval" &&
    (allocation.asset.kind === "ERC20" || allocation.asset.kind === "ERC721") &&
    onRestoreApproval;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "4px" }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "3px 8px",
          borderRadius: 0,
          fontSize: "0.75rem",
          fontWeight: 600,
          backgroundColor: tone.background,
          color: tone.color,
        }}
      >
        <span
          aria-hidden="true"
          style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: "currentColor", flexShrink: 0 }}
        />
        {copy.label}
      </span>
      <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", lineHeight: 1.4, maxWidth: 240 }}>
        {copy.detail}
      </span>
      {canRestore && (
        <button
          type="button"
          onClick={onRestoreApproval}
          disabled={isRestoring}
          className="btn-secondary"
          style={{ padding: "4px 10px", fontSize: "0.75rem", marginTop: "2px" }}
        >
          {isRestoring ? "Re-approving…" : "Re-approve"}
        </button>
      )}
    </div>
  );
}

interface BannerProps {
  readiness: AllocationReadiness;
  perspective: HealthPerspective;
  isLoading?: boolean;
}

/**
 * One-line answer to "if the owner died today, would the heirs actually
 * receive what they were promised?"
 */
export function AllocationReadinessBanner({ readiness, perspective, isLoading }: BannerProps) {
  const { pending, backed, broken, unknown } = readiness;
  if (pending === 0) return null;

  let tone: Tone;
  let headline: string;
  let detail: string;

  if (isLoading && backed + broken === 0) {
    tone = "muted";
    headline = "Checking allocations…";
    detail = "Reading what the owner's wallet currently holds and has approved.";
  } else if (broken > 0) {
    tone = "bad";
    headline =
      broken === pending
        ? `${pending === 1 ? "This allocation" : `All ${pending} allocations`} would not pay out in full today`
        : `${broken} of ${pending} allocations would not pay out in full today`;
    detail =
      perspective === "owner"
        ? "Assets stay in your wallet, so spending them or revoking an approval breaks an allocation. Fix the ones marked below."
        : "Assets stay in the owner's wallet, and some of them are no longer funded or approved.";
  } else if (unknown > 0) {
    tone = "muted";
    headline = `${backed} of ${pending} allocations confirmed backed`;
    detail = "The rest could not be checked right now.";
  } else {
    tone = "ok";
    headline =
      pending === 1 ? "This allocation is fully backed" : `All ${pending} allocations are fully backed`;
    detail =
      perspective === "owner"
        ? "Your assets never leave your wallet. Each allocation is checked live and would transfer in full if claimed today."
        : "Assets stay in the owner's wallet. Each allocation is checked live and would transfer in full if claimed today.";
  }

  const { color, background } = TONES[tone];

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        gap: "12px",
        alignItems: "flex-start",
        padding: "14px 16px",
        marginBottom: "16px",
        borderLeft: `3px solid ${color}`,
        backgroundColor: background,
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 8, height: 8, marginTop: 6, borderRadius: "50%", backgroundColor: color, flexShrink: 0 }}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <strong style={{ fontSize: "0.875rem", color: "var(--text-primary)", fontWeight: 600 }}>{headline}</strong>
        <span style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>{detail}</span>
      </div>
    </div>
  );
}
