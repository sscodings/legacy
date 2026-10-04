"use client";

import React, { useState } from "react";
import { shortAddress } from "@/lib/constants";

interface VaultIdentityBarProps {
  vaultAddress: `0x${string}`;
  vaultName?: string;
  ownerName?: string;
  onBack: () => void;
  /** Persists new names; resolves false when the save failed. */
  onSaveNames: (names: { vaultName: string; ownerName: string }) => Promise<boolean>;
}

const MAX_NAME_LENGTH = 60;

/**
 * Top bar of the vault console: who/what this vault is, in human terms.
 * The vault name leads; the contract address is demoted to a small,
 * copyable detail. Names can be edited inline.
 */
export function VaultIdentityBar({
  vaultAddress,
  vaultName,
  ownerName,
  onBack,
  onSaveNames,
}: VaultIdentityBarProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftVault, setDraftVault] = useState("");
  const [draftOwner, setDraftOwner] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const startEditing = () => {
    setDraftVault(vaultName ?? "");
    setDraftOwner(ownerName ?? "");
    setError(null);
    setIsEditing(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = draftVault.trim();
    const o = draftOwner.trim();
    if (!v || !o) {
      setError("Both names are required.");
      return;
    }
    setIsSaving(true);
    const ok = await onSaveNames({ vaultName: v, ownerName: o });
    setIsSaving(false);
    if (ok) setIsEditing(false);
    else setError("Couldn't save names. Try again.");
  };

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(vaultAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable — address is still visible */
    }
  };

  return (
    <div className="console-identity">
      <button type="button" onClick={onBack} className="flow-btn flow-btn--ghost console-back" aria-label="All vaults" title="All vaults">
        <span aria-hidden="true">←</span>
      </button>

      {isEditing ? (
        <form onSubmit={handleSave} style={{ display: "flex", alignItems: "flex-end", gap: "10px", flexWrap: "wrap", flex: 1 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.6875rem", color: "var(--text-secondary)" }}>
            Vault name
            <input
              className="flow-input"
              value={draftVault}
              onChange={(e) => setDraftVault(e.target.value)}
              maxLength={MAX_NAME_LENGTH}
              placeholder="e.g. Family Estate"
              autoFocus
              style={{ minWidth: 220, padding: "9px 12px" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.6875rem", color: "var(--text-secondary)" }}>
            Your name (shown to heirs)
            <input
              className="flow-input"
              value={draftOwner}
              onChange={(e) => setDraftOwner(e.target.value)}
              maxLength={MAX_NAME_LENGTH}
              placeholder="e.g. Maria Chen"
              autoComplete="name"
              style={{ minWidth: 220, padding: "9px 12px" }}
            />
          </label>
          <button type="submit" disabled={isSaving} className="flow-btn">
            {isSaving ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={() => setIsEditing(false)} className="flow-btn flow-btn--ghost">
            Cancel
          </button>
          {error && <span style={{ color: "var(--status-red)", fontSize: "0.75rem", alignSelf: "center" }}>{error}</span>}
        </form>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
              <h1
                style={{
                  fontFamily: "'Murs Gothic', var(--font-murs-gothic), sans-serif",
                  fontSize: "1.5rem",
                  color: vaultName ? "#ffffff" : "var(--text-secondary)",
                  letterSpacing: "0.03em",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  margin: 0,
                }}
              >
                {vaultName ?? "Unnamed vault"}
              </h1>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.75rem", color: "var(--text-secondary)", flexWrap: "wrap" }}>
              <span>
                Owned by <span style={{ color: "var(--text-primary)" }}>{ownerName ? `${ownerName} (you)` : "you"}</span>
              </span>
              <span className="meta-sep" aria-hidden="true" />
              <button
                type="button"
                onClick={copyAddress}
                title="Copy vault contract address"
                aria-live="polite"
                className="font-data"
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text-secondary)", fontSize: "0.6875rem" }}
              >
                {copied ? "Address copied" : shortAddress(vaultAddress)}
              </button>
              <span className="meta-sep" aria-hidden="true" />
              <a
                href={`https://sepolia.worldscan.org/address/${vaultAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flow-link"
                style={{ fontSize: "0.75rem" }}
              >
                Worldscan ↗
              </a>
            </div>
          </div>
          <button type="button" onClick={startEditing} className="flow-btn flow-btn--ghost">
            {vaultName && ownerName ? "Rename" : "Add names"}
          </button>
        </>
      )}
    </div>
  );
}
