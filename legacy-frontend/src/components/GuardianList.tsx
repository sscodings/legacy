"use client";

import React, { useState } from "react";
import { VaultStatus } from "@/lib/constants";
import { AddressChip } from "./AddressChip";

interface GuardianListProps {
  guardians: readonly `0x${string}`[];
  vaultStatus: VaultStatus;
  deathConfirmed: boolean;
  attestationCount: number;
  onAddGuardian: (guardian: `0x${string}`) => Promise<void>;
  onRemoveGuardian: (guardian: `0x${string}`) => Promise<void>;
  isLoading?: boolean;
}

export function GuardianList({
  guardians,
  vaultStatus,
  deathConfirmed,
  attestationCount,
  onAddGuardian,
  onRemoveGuardian,
  isLoading = false,
}: GuardianListProps) {
  const [newGuardianInput, setNewGuardianInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const isGreen = vaultStatus === VaultStatus.Green;
  const total = guardians.length;
  const pct = total > 0 ? Math.round((attestationCount / total) * 100) : 0;

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const addr = newGuardianInput.trim();
    if (!addr.startsWith("0x") || addr.length !== 42) {
      setErrorText("Enter a valid 42-character Ethereum address (0x...)");
      return;
    }
    try {
      setIsSubmitting(true);
      setErrorText(null);
      await onAddGuardian(addr as `0x${string}`);
      setNewGuardianInput("");
    } catch (err: unknown) {
      setErrorText(err instanceof Error ? err.message : "Failed to add guardian");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemove = async (guardian: `0x${string}`) => {
    try {
      setIsSubmitting(true);
      setErrorText(null);
      await onRemoveGuardian(guardian);
    } catch (err: unknown) {
      setErrorText(err instanceof Error ? err.message : "Failed to remove guardian");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h3
            style={{
              fontFamily: "'Murs Gothic', var(--font-murs-gothic), sans-serif",
              fontSize: "1.375rem",
              fontWeight: 900,
              letterSpacing: "0.06em",
              color: "#ffffff",
              textTransform: "uppercase",
              margin: 0,
            }}
          >
            Guardians
          </h3>
          <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginTop: "4px", lineHeight: 1.5, maxWidth: 620 }}>
            People who can confirm your passing. If all of them do, your heirs can inherit almost immediately. Checking in cancels it.
          </p>
        </div>
        {!isGreen && (
          <span className="lock-note">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            Check in to make changes
          </span>
        )}
      </div>

      {/* Attestation progress / confirmed banner */}
      {total > 0 && (
        <div
          style={{
            border: `1px solid ${deathConfirmed ? "var(--status-red)" : "rgba(255, 255, 255, 0.15)"}`,
            backgroundColor: deathConfirmed ? "rgba(193, 80, 63, 0.08)" : "rgba(255, 255, 255, 0.015)",
            padding: "16px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="font-data" style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Death Attestations
            </span>
            <span className="font-data" style={{ fontSize: "0.9375rem", color: "#ffffff", fontWeight: 700 }}>
              {attestationCount} / {total}
            </span>
          </div>
          <div style={{ height: 8, backgroundColor: "rgba(255, 255, 255, 0.08)", overflow: "hidden" }}>
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                backgroundColor: deathConfirmed ? "var(--status-red)" : "var(--accent-brass)",
                boxShadow: `0 0 8px ${deathConfirmed ? "var(--status-red)" : "var(--accent-brass)"}`,
                transition: "width 0.4s ease-out",
              }}
            />
          </div>
          {deathConfirmed && (
            <span style={{ color: "var(--status-red)", fontSize: "0.8125rem", fontWeight: 600 }}>
              Unanimous — accelerated succession is active. Check in with World ID to cancel.
            </span>
          )}
        </div>
      )}

      {/* Add guardian form */}
      {isGreen && (
        <form onSubmit={handleAdd} style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <input
            type="text"
            className="input-instrument font-data"
            placeholder="0x… guardian wallet address"
            value={newGuardianInput}
            onChange={(e) => setNewGuardianInput(e.target.value)}
            disabled={isSubmitting || isLoading}
            style={{
              flex: "1 1 320px",
              fontSize: "0.875rem",
              backgroundColor: "#000000",
              borderColor: "rgba(255, 255, 255, 0.2)",
              padding: "12px 16px",
              borderRadius: 0,
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="submit"
            className="btn-brass"
            disabled={isSubmitting || isLoading || !newGuardianInput.trim()}
            style={{ padding: "12px 24px", fontSize: "0.8125rem", whiteSpace: "nowrap", borderRadius: 0 }}
          >
            {isSubmitting ? "ADDING…" : "+ ADD GUARDIAN"}
          </button>
        </form>
      )}

      {errorText && (
        <div
          style={{
            padding: "12px 16px",
            backgroundColor: "rgba(193, 80, 63, 0.15)",
            border: "1px solid var(--status-red)",
            borderRadius: 0,
            fontSize: "0.8125rem",
            color: "#ffffff",
          }}
        >
          {errorText}
        </div>
      )}

      {/* Table */}
      {guardians.length === 0 ? (
        <div
          style={{
            padding: "32px 24px",
            border: "1px dashed rgba(255, 255, 255, 0.12)",
            backgroundColor: "rgba(255, 255, 255, 0.01)",
          }}
        >
          <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", margin: 0 }}>
            {isGreen ? "No guardians yet. Add someone you trust above." : "No guardians yet. Check in to start adding them."}
          </p>
        </div>
      ) : (
        <div style={{ border: "1px solid rgba(255, 255, 255, 0.15)", overflow: "hidden" }}>
          <table className="table-instrument">
            <thead>
              <tr style={{ backgroundColor: "rgba(255, 255, 255, 0.04)" }}>
                <th style={{ width: "80px" }}>INDEX</th>
                <th>GUARDIAN ADDRESS</th>
                <th>ROLE</th>
                {isGreen && <th style={{ textAlign: "right" }}>ACTION</th>}
              </tr>
            </thead>
            <tbody>
              {guardians.map((guardian, idx) => (
                <tr key={guardian}>
                  <td className="font-data" style={{ color: "var(--accent-brass)", fontSize: "0.8125rem" }}>
                    0{idx + 1}{" //"}
                  </td>
                  <td>
                    <AddressChip address={guardian} badge="" size="md" />
                  </td>
                  <td style={{ color: "var(--text-secondary)", fontSize: "0.8125rem", fontFamily: "var(--font-data)" }}>
                    GUARDIAN #{idx + 1}
                  </td>
                  {isGreen && (
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        onClick={() => handleRemove(guardian)}
                        disabled={isSubmitting}
                        className="btn-secondary"
                        style={{
                          padding: "6px 12px",
                          fontSize: "0.75rem",
                          borderRadius: 0,
                          borderColor: "rgba(193, 80, 63, 0.35)",
                          color: "var(--status-red)",
                        }}
                      >
                        REMOVE
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
