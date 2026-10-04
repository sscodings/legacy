"use client";

import React from "react";
import { useDialogBehavior } from "@/hooks/useDialogBehavior";

export type DeploymentStage =
  | "idle"
  | "requesting_signature"
  | "broadcasting"
  | "confirming"
  | "indexing"
  | "syncing"
  | "success"
  | "error";

interface VaultDeploymentModalProps {
  isOpen: boolean;
  stage: DeploymentStage;
  txHash: string | null;
  vaultAddress: string | null;
  errorMessage: string | null;
  onRetry?: () => void;
  onClose: () => void;
}

// The pipeline has more internal stages than users need to see; each
// visible step covers a group of them.
const STEPS: { label: string; activeOn: DeploymentStage[] }[] = [
  { label: "Confirm in your wallet", activeOn: ["requesting_signature"] },
  { label: "Create vault on World Chain", activeOn: ["broadcasting", "confirming", "indexing"] },
  { label: "Finish setup", activeOn: ["syncing"] },
];

const STAGE_ORDER: DeploymentStage[] = [
  "requesting_signature",
  "broadcasting",
  "confirming",
  "indexing",
  "syncing",
  "success",
];

function stepState(stepIndex: number, stage: DeploymentStage, failedAt: number): "done" | "active" | "failed" | "idle" {
  if (stage === "error") {
    if (stepIndex < failedAt) return "done";
    return stepIndex === failedAt ? "failed" : "idle";
  }
  const current = STAGE_ORDER.indexOf(stage);
  const firstOfStep = STAGE_ORDER.indexOf(STEPS[stepIndex].activeOn[0]);
  const lastOfStep = STAGE_ORDER.indexOf(STEPS[stepIndex].activeOn[STEPS[stepIndex].activeOn.length - 1]);
  if (current > lastOfStep) return "done";
  if (current >= firstOfStep) return "active";
  return "idle";
}

function StepIcon({ state }: { state: ReturnType<typeof stepState> }) {
  if (state === "done") {
    return (
      <span className="flow-dot flow-dot--done" aria-hidden="true">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="flow-dot flow-dot--failed" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </span>
    );
  }
  return <span className={`flow-dot${state === "active" ? " flow-dot--active" : ""}`} aria-hidden="true" />;
}

export function VaultDeploymentModal({
  isOpen,
  stage,
  txHash,
  errorMessage,
  onRetry,
  onClose,
}: VaultDeploymentModalProps) {
  // Remember which step was running when an error hit, so the right one shows ✕.
  const [failedAt, setFailedAt] = React.useState(0);
  const [lastStage, setLastStage] = React.useState<DeploymentStage>(stage);
  if (stage !== lastStage) {
    if (stage === "error") {
      const idx = STEPS.findIndex((s) => s.activeOn.includes(lastStage));
      setFailedAt(idx === -1 ? 0 : idx);
    }
    setLastStage(stage);
  }

  // Only dismissible once the flow has settled; never mid-transaction.
  const dialogRef = useDialogBehavior<HTMLDivElement>(isOpen, stage === "error" || stage === "success" ? onClose : undefined);

  if (!isOpen) return null;

  const isDone = stage === "success";
  const isError = stage === "error";

  const title = isDone ? "Vault created" : isError ? "Couldn't create vault" : "Creating your vault";
  const subtitle = isDone
    ? "Next, add the people who'll inherit it."
    : isError
    ? null
    : stage === "requesting_signature"
    ? "Approve the request in your wallet."
    : stage === "syncing"
    ? "Almost there…"
    : "This usually takes a few seconds.";

  return (
    <div
      className="deployment-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && (isError || isDone)) onClose();
      }}
    >
      <div ref={dialogRef} className="deployment-modal" role="dialog" aria-modal="true" aria-labelledby="deploy-title">
        <div className="flow-header">
          <h2 id="deploy-title" className="flow-title">
            {title}
          </h2>
          {subtitle && <p className="flow-sub">{subtitle}</p>}
          {isError && (
            <p className="flow-error">{errorMessage || "Something went wrong. Please try again."}</p>
          )}
          {(isError || isDone) && (
            <button type="button" onClick={onClose} className="flow-close" aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <ol className="flow-steps">
          {STEPS.map((step, i) => {
            const state = stepState(i, stage, failedAt);
            return (
              <li key={step.label} className={`flow-step flow-step--${state}`}>
                <StepIcon state={state} />
                <span>{step.label}</span>
              </li>
            );
          })}
        </ol>

        <div className="flow-footer">
          {txHash ? (
            <a
              href={`https://sepolia.worldscan.org/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flow-link"
            >
              View transaction ↗
            </a>
          ) : (
            <span />
          )}

          {isError ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={onClose} className="flow-btn flow-btn--ghost">
                Close
              </button>
              {onRetry && (
                <button type="button" onClick={onRetry} className="flow-btn">
                  Try again
                </button>
              )}
            </div>
          ) : isDone ? (
            <button type="button" onClick={onClose} className="flow-btn">
              Open vault →
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
