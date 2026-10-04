"use client";

import React, { useState } from "react";
import { useDialogBehavior } from "@/hooks/useDialogBehavior";
import { useReadContract } from "wagmi";
import { decodeAbiParameters } from "viem";
import { IDKitRequestWidget, orbLegacy, type RpContext, type IDKitResult } from "@worldcoin/idkit";
import { computeSignalHashHex } from "@/lib/signal";
import { WORLD_ID_CONFIG } from "@/lib/constants";

interface CheckInModalProps {
  isOpen: boolean;
  onClose: () => void;
  vaultAddress: `0x${string}`;
  ownerAddress: `0x${string}`;
  livenessRegistered: boolean;
  verifierAddress?: `0x${string}`;
  onCheckInSuccess: (message: string) => void;
  onPerformCheckInTx: (
    root: bigint,
    nullifierHash: bigint,
    proof: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
  ) => Promise<void>;
  onRegisterLivenessTx: (
    root: bigint,
    nullifierHash: bigint,
    proof: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
  ) => Promise<void>;
}

function parseProof(proofRaw: unknown): readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint] {
  if (!proofRaw) {
    throw new Error("Missing proof in World ID response");
  }
  if (typeof proofRaw === "string") {
    const trimmed = proofRaw.trim();
    if (trimmed.startsWith("0x")) {
      const decoded = decodeAbiParameters([{ type: "uint256[8]" }], trimmed as `0x${string}`)[0];
      return decoded as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
    }
    if (trimmed.startsWith("[")) {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr) && arr.length === 8) {
        return arr.map((x) => BigInt(x)) as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
      }
    }
  }
  if (Array.isArray(proofRaw) && proofRaw.length === 8) {
    return proofRaw.map((x) => BigInt(x)) as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  }
  throw new Error("Unable to parse World ID ZK proof into uint256[8] format");
}

export function CheckInModal({
  isOpen,
  onClose,
  vaultAddress,
  ownerAddress,
  livenessRegistered,
  verifierAddress,
  onCheckInSuccess,
  onPerformCheckInTx,
  onRegisterLivenessTx,
}: CheckInModalProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [warningText, setWarningText] = useState<string | null>(null);
  const [isIdkitOpen, setIsIdkitOpen] = useState(false);
  const [rpContext, setRpContext] = useState<RpContext | undefined>(undefined);
  const [environment, setEnvironment] = useState<"staging" | "production">("staging");

  const { data: registeredNullifierRaw } = useReadContract({
    address: verifierAddress,
    abi: [
      {
        inputs: [{ name: "vault", type: "address" }],
        name: "vaultNullifier",
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
    ] as const,
    functionName: "vaultNullifier",
    args: vaultAddress ? [vaultAddress] : undefined,
    query: { enabled: Boolean(verifierAddress) && Boolean(vaultAddress) },
  });

  // Step aside while the World ID overlay is up so it keeps its own focus and Escape handling.
  const dialogRef = useDialogBehavior<HTMLDivElement>(
    isOpen && !isIdkitOpen,
    isProcessing ? undefined : onClose
  );

  if (!isOpen) return null;

  const signalHex = computeSignalHashHex(vaultAddress, ownerAddress);

  // Execute on-chain check-in with ZK proof
  const handleExecuteProof = async (
    root: bigint,
    nullifierHash: bigint,
    proof: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
    isRegister: boolean
  ) => {
    try {
      setIsProcessing(true);
      setErrorText(null);

      console.log("👉 [CheckInModal] Executing on-chain transaction:", {
        action: isRegister ? "registerLiveness" : "checkIn",
        vaultAddress,
        ownerAddress,
        root: root.toString(),
        nullifierHash: nullifierHash.toString(),
        verifierAddress,
        registeredNullifier: registeredNullifierRaw?.toString(),
      });

      // Pre-flight check: if checking in on an already-registered vault, ensure nullifier matches
      if (!isRegister && registeredNullifierRaw !== undefined && registeredNullifierRaw !== 0n) {
        if (nullifierHash !== registeredNullifierRaw) {
          throw new Error(
            `Nullifier Mismatch: This vault (${vaultAddress.slice(0, 6)}...${vaultAddress.slice(-4)}) is already registered with nullifier ${registeredNullifierRaw.toString().slice(0, 10)}.... Your current session generated a different World ID nullifier (${nullifierHash.toString().slice(0, 10)}...). Please check in using the original World ID persona that registered this vault.`
          );
        }
      }

      if (isRegister) {
        await onRegisterLivenessTx(root, nullifierHash, proof);
        console.log("✅ [CheckInModal] onRegisterLivenessTx completed successfully");
        onCheckInSuccess("Liveness registered. Next check-in due in 30 days.");
      } else {
        await onPerformCheckInTx(root, nullifierHash, proof);
        console.log("✅ [CheckInModal] onPerformCheckInTx completed successfully");
        onCheckInSuccess("Checked in. Next check-in due in 30 days.");
      }
      onClose();
    } catch (err: unknown) {
      console.error("❌ [CheckInModal] Transaction / signature error:", err);
      let msg = err instanceof Error ? err.message : "Transaction failed";
      if (msg.includes("NullifierMismatch") || msg.includes("b9ab99df")) {
        msg = "Check-in reverted (NullifierMismatch): The submitted nullifier does not match this vault's registered nullifier. Each vault can only be refreshed by its initial registered identity.";
      } else if (msg.includes("NullifierNotRegistered") || msg.includes("c1170bc3")) {
        msg = "Verification reverted (NullifierNotRegistered): Please register liveness first before performing routine check-ins.";
      } else if (
        msg.includes("NonExistentRoot") ||
        msg.includes("ddae3b71") ||
        msg.includes("gas limit too high") ||
        msg.includes("0x12c1")
      ) {
        msg = "Verification reverted: This vault is linked to the production World ID router verifier (0x9200aba1...), which rejects testnet roots. Please close this modal and click '+ Create new vault' on the dashboard to create a vault connected to the verified testnet verifier (0xbc53b9fa...), where staging proofs work smoothly.";
      }
      setErrorText(msg);
      throw err;
    } finally {
      setIsProcessing(false);
    }
  };

  // Launch official World ID IDKit widget
  const handleOpenIdkitWidget = async () => {
    try {
      setIsProcessing(true);
      setErrorText(null);
      setWarningText(null);

      console.log("👉 [CheckInModal] Requesting RP signature from /api/rp-signature for action:", WORLD_ID_CONFIG.action);

      // 1. Fetch Relying Party signature from backend
      const rpRes = await fetch("/api/rp-signature", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: WORLD_ID_CONFIG.action }),
      });

      if (!rpRes.ok) {
        const errorJson = await rpRes.json().catch(() => ({}));
        console.error("❌ [CheckInModal] /api/rp-signature returned error:", errorJson);
        throw new Error(errorJson.error || "Failed to obtain Relying Party signature from backend (/api/rp-signature)");
      }

      const rpSig = await rpRes.json();
      console.log("✅ [CheckInModal] Received RP signature payload:", rpSig);

      if (rpSig.key_warning) {
        setWarningText(rpSig.key_warning);
      }

      const cleanRpId = (rpSig.rp_id || WORLD_ID_CONFIG.rpId) as `rp_${string}`;
      if (!cleanRpId) {
        throw new Error("Missing rp_id: Please configure NEXT_PUBLIC_WORLD_ID_RP_ID in .env.local");
      }

      if (!WORLD_ID_CONFIG.appId) {
        throw new Error("Missing app_id: Please configure NEXT_PUBLIC_WORLD_ID_APP_ID in .env.local");
      }

      setRpContext({
        rp_id: cleanRpId,
        nonce: rpSig.nonce,
        created_at: rpSig.created_at,
        expires_at: rpSig.expires_at,
        signature: rpSig.sig,
      });

      // Open official World ID widget modal
      setIsIdkitOpen(true);
    } catch (err: unknown) {
      console.error("❌ [CheckInModal] Failed to initialize IDKit:", err);
      const msg = err instanceof Error ? err.message : "Failed to initialize World ID IDKit";
      setErrorText(msg);
    } finally {
      setIsProcessing(false);
    }
  };

  // Callback from IDKit when user verifies in World App / Simulator
  const handleVerifyIdkit = async (result: IDKitResult) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawResult: any = result;
    const item =
      rawResult?.responses?.[0] ||
      rawResult?.result?.responses?.[0] ||
      rawResult?.result ||
      rawResult;

    if (!item) {
      throw new Error("No credential response item found in World ID payload");
    }

    const rootStr = item.merkle_root || item.root;
    const nullifierStr = item.nullifier || item.nullifier_hash;
    if (!rootStr || !nullifierStr) {
      throw new Error("Missing merkle_root or nullifier in World ID response");
    }

    const root = BigInt(rootStr);
    const nullifierHash = BigInt(nullifierStr);
    const parsedProof = parseProof(item.proof);

    // 1. Execute on-chain ZK verification on World Chain Sepolia
    await handleExecuteProof(root, nullifierHash, parsedProof, !livenessRegistered);

    // 2. Also forward proof to backend verification endpoint (Step 5 of IDKit integration)
    try {
      await fetch("/api/verify-proof", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rp_id: rpContext?.rp_id,
          idkitResponse: result,
        }),
      });
    } catch (e) {
      console.warn("Backend Developer Portal verify error (non-fatal for on-chain contract):", e);
    }
  };

  return (
    <>
      {/* Official World ID Request Widget */}
      {rpContext && (
        <IDKitRequestWidget
          open={isIdkitOpen}
          onOpenChange={setIsIdkitOpen}
          app_id={WORLD_ID_CONFIG.appId}
          action={WORLD_ID_CONFIG.action}
          rp_context={rpContext}
          allow_legacy_proofs={true}
          environment={environment}
          preset={orbLegacy({ signal: signalHex })}
          handleVerify={handleVerifyIdkit}
          onSuccess={() => {
            onCheckInSuccess(
              livenessRegistered
                ? "Checked in via World ID. Liveness renewed."
                : "Initial World ID liveness registered on-chain."
            );
            onClose();
          }}
          onError={(err) => {
            const msg =
              typeof err === "object" && err !== null && "message" in err
                ? (err as Error).message
                : String(err);
            setErrorText(`World ID Verification: ${msg}`);
          }}
        />
      )}

      {/* Legacy Liveness / Check-In Modal Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkin-modal-title"
        className="modal-backdrop-animate"
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(10, 13, 16, 0.88)",
          backdropFilter: "blur(6px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
          padding: "20px",
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && !isProcessing) onClose();
        }}
      >
        <div
          ref={dialogRef}
          className="panel-elevated modal-surface-animate"
          style={{
            width: "100%",
            maxWidth: "520px",
            padding: "32px",
            backgroundColor: "#0A0D10",
            border: "1px solid rgba(255, 255, 255, 0.16)",
            borderRadius: 0,
            display: "flex",
            flexDirection: "column",
            gap: "20px",
            position: "relative",
            boxShadow: "0 24px 64px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.05)",
          }}
        >
          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px" }}>
            <div>
              <span className="section-tag" style={{ margin: "0 0 6px", fontSize: "0.6875rem" }}>
                {livenessRegistered ? "[ CHECK-IN ]" : "[ ONE-TIME SETUP ]"}
              </span>
              <h2
                id="checkin-modal-title"
                style={{
                  fontFamily: "'Murs Gothic', var(--font-murs-gothic), sans-serif",
                  fontSize: "1.375rem",
                  fontWeight: 900,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "#ffffff",
                  lineHeight: 1.15,
                  margin: 0,
                }}
              >
                {livenessRegistered ? "Check in" : "Set up World ID"}
              </h2>
              <p
                style={{
                  fontSize: "0.8125rem",
                  color: "var(--text-secondary)",
                  marginTop: "6px",
                  lineHeight: 1.5,
                }}
              >
                {livenessRegistered
                  ? "Prove you're still here. This restarts your timer and cancels any open claim."
                  : "Verify once with World ID to switch on check-ins for this vault."}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={isProcessing}
              className="btn-secondary"
              style={{
                padding: "6px 12px",
                fontFamily: "var(--font-data)",
                fontSize: "0.75rem",
                letterSpacing: "0.06em",
                borderRadius: 0,
                borderColor: "rgba(255, 255, 255, 0.2)",
                color: "var(--text-secondary)",
                flexShrink: 0,
              }}
              aria-label="Close dialog"
            >
              Close ✕
            </button>
          </div>

          {/* Verification Environment Toggle */}
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "10px 14px",
                background: "#000000",
                border: "1px solid rgba(255, 255, 255, 0.12)",
              }}
            >
              <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase" }}>
                Verify with
              </span>
              <div role="group" aria-label="Verification environment" style={{ display: "flex", gap: "6px" }}>
                <button
                  type="button"
                  onClick={() => setEnvironment("staging")}
                  aria-pressed={environment === "staging"}
                  style={{
                    padding: "4px 8px",
                    fontSize: "0.6875rem",
                    fontFamily: "var(--font-data)",
                    backgroundColor: environment === "staging" ? "rgba(184, 137, 74, 0.25)" : "transparent",
                    color: environment === "staging" ? "var(--accent-brass)" : "var(--text-secondary)",
                    border: environment === "staging" ? "1px solid var(--accent-brass)" : "1px solid rgba(255, 255, 255, 0.15)",
                    cursor: "pointer",
                  }}
                >
                  Simulator (test)
                </button>
                <button
                  type="button"
                  onClick={() => setEnvironment("production")}
                  aria-pressed={environment === "production"}
                  style={{
                    padding: "4px 8px",
                    fontSize: "0.6875rem",
                    fontFamily: "var(--font-data)",
                    backgroundColor: environment === "production" ? "rgba(76, 175, 109, 0.2)" : "transparent",
                    color: environment === "production" ? "var(--status-green)" : "var(--text-secondary)",
                    border: environment === "production" ? "1px solid var(--status-green)" : "1px solid rgba(255, 255, 255, 0.15)",
                    cursor: "pointer",
                  }}
                >
                  World App (real)
                </button>
              </div>
            </div>
          </div>

          {/* Telemetry and Signal Box */}
          <div
            style={{
              padding: "16px",
              backgroundColor: "#000000",
              border: "1px solid rgba(255, 255, 255, 0.12)",
              borderRadius: 0,
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <span className="section-tag" style={{ margin: 0, fontSize: "0.625rem" }}>
              [ DETAILS ]
            </span>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Vault
              </span>
              <span className="font-data" style={{ color: "#ffffff", fontSize: "0.8125rem" }}>
                {vaultAddress.slice(0, 10)}...{vaultAddress.slice(-8)}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Verification
              </span>
              <span style={{ color: "var(--accent-brass)", fontFamily: "var(--font-data)", fontSize: "0.75rem", fontWeight: 600 }}>
                World ID (Orb)
              </span>
            </div>
          </div>

          {/* Key Warning if applicable */}
          {warningText && (
            <div
              style={{
                padding: "10px 14px",
                backgroundColor: "rgba(217, 154, 61, 0.08)",
                border: "1px solid var(--status-amber)",
                fontSize: "0.75rem",
                color: "var(--text-secondary)",
                lineHeight: 1.5,
              }}
            >
              <div style={{ color: "var(--status-amber)", fontWeight: 600, marginBottom: "2px" }}>
                [ NOTICE ]
              </div>
              {warningText}
            </div>
          )}

          {/* Error Banner */}
          {errorText && (
            <div
              role="alert"
              style={{
                padding: "12px 16px",
                backgroundColor: "rgba(193, 80, 63, 0.12)",
                border: "1px solid var(--status-red)",
                borderRadius: 0,
                fontSize: "0.8125rem",
                color: "#ffffff",
                lineHeight: 1.5,
              }}
            >
              <div style={{ color: "var(--status-red)", fontFamily: "var(--font-data)", fontSize: "0.6875rem", letterSpacing: "0.08em", marginBottom: "4px" }}>
                [ COULDN&apos;T VERIFY ]
              </div>
              {errorText}
            </div>
          )}

          {/* Action Button */}
          <button
            type="button"
            onClick={handleOpenIdkitWidget}
            disabled={isProcessing}
            className="btn-hero-action"
            style={{
              width: "100%",
              justifyContent: "center",
              marginTop: "4px",
              borderRadius: 0,
              padding: "14px 28px",
              fontSize: "0.875rem",
            }}
          >
            <span>
              {isProcessing ? "OPENING WORLD ID…" : "CONTINUE WITH WORLD ID"}
            </span>
            <span className="arrow-icon" aria-hidden="true">→</span>
          </button>

          <p
            style={{
              fontSize: "0.6875rem",
              fontFamily: "var(--font-data)",
              letterSpacing: "0.04em",
              color: "var(--text-secondary)",
              textAlign: "center",
              textTransform: "uppercase",
              margin: 0,
            }}
          >
            Non-custodial · Verified on World Chain
          </p>
        </div>
      </div>
    </>
  );
}
