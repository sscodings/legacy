"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { isAddress } from "viem";
import { useReadContract } from "wagmi";
import { VaultStatus, CONTRACT_ADDRESSES, shortAddress, humanDuration, timeAgo } from "@/lib/constants";
import { fetchVaultMeta, type VaultMetaRecord } from "@/lib/vault-meta/client";
import { LegacyVaultABI } from "@/lib/contracts/abis";
import { StatusLamp } from "@/components/StatusLamp";
import { TransparencyLookupSkeleton } from "@/components/Skeleton";

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <button
      type="button"
      onClick={copy}
      title="Copy to clipboard"
      style={{
        background: "none",
        border: "none",
        padding: "4px 6px",
        cursor: "pointer",
        color: copied ? "var(--accent-brass)" : "var(--text-secondary)",
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      aria-label="Copy address"
    >
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="1" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

const WORLDSCAN = "https://sepolia.worldscan.org/address";

const WHAT_YOU_SEE = [
  { value: "STATUS", label: "Is the owner still checking in?" },
  { value: "LAST CHECK-IN", label: "When they last proved they're alive" },
  { value: "TIMING", label: "How long until heirs can claim" },
];

/** One label/value row in the results list. */
function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="data-row" style={{ alignItems: "center" }}>
      <span style={{ color: "var(--text-secondary)", flexShrink: 0 }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, color: "#ffffff", textAlign: "right" }}>
        {children}
      </div>
    </div>
  );
}

export default function TransparencyLookup() {
  const [searchInput, setSearchInput] = useState<string>("");
  const [queriedAddress, setQueriedAddress] = useState<`0x${string}` | null>(null);
  const searchParams = useSearchParams();

  // Shareable deep link (?v=0x...) — same convention as the claim page
  useEffect(() => {
    const v = searchParams.get("v");
    if (v && isAddress(v)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- prefilling from URL on mount, not a derived-state loop
      setSearchInput(v);
      setQueriedAddress(v as `0x${string}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trimmedInput = searchInput.trim();
  const inputIsValid = isAddress(trimmedInput);

  // Keep the address bar in sync so a result can be bookmarked or shared as-is
  const syncUrl = (addr: string | null) => {
    try {
      const url = new URL(window.location.href);
      if (addr) url.searchParams.set("v", addr);
      else url.searchParams.delete("v");
      window.history.replaceState(null, "", url);
    } catch {}
  };

  const runLookup = (addr: `0x${string}`) => {
    setQueriedAddress(addr);
    syncUrl(addr);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputIsValid) return;
    runLookup(trimmedInput as `0x${string}`);
  };

  // Pasting a complete address is the whole intent — skip the extra click
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text").trim();
    if (!isAddress(pasted)) return;
    e.preventDefault();
    setSearchInput(pasted);
    runLookup(pasted as `0x${string}`);
  };

  const handleQuickLoadSmoke = () => {
    setSearchInput(CONTRACT_ADDRESSES.smokeVault);
    runLookup(CONTRACT_ADDRESSES.smokeVault);
  };

  const [linkCopied, setLinkCopied] = useState(false);
  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1800);
    } catch {}
  };

  const handleReset = () => {
    setSearchInput("");
    setQueriedAddress(null);
    setLinkCopied(false);
    syncUrl(null);
    document.getElementById("vault-lookup-input")?.focus();
  };

  // ── Reads ─────────────────────────────────────────────────────────
  const { data: rawStatus, isLoading: isStatusLoading, isError: isStatusError } = useReadContract({
    address: queriedAddress ?? undefined,
    abi: LegacyVaultABI,
    functionName: "getStatus",
    query: { enabled: Boolean(queriedAddress) },
  });

  const { data: owner, isLoading: isOwnerLoading } = useReadContract({
    address: queriedAddress ?? undefined,
    abi: LegacyVaultABI,
    functionName: "owner",
    query: { enabled: Boolean(queriedAddress) },
  });

  const { data: heirCount } = useReadContract({
    address: queriedAddress ?? undefined,
    abi: LegacyVaultABI,
    functionName: "getHeirCount",
    query: { enabled: Boolean(queriedAddress) },
  });

  const { data: lastCheckInRaw } = useReadContract({
    address: queriedAddress ?? undefined,
    abi: LegacyVaultABI,
    functionName: "lastCheckIn",
    query: { enabled: Boolean(queriedAddress) },
  });

  const { data: intervalRaw } = useReadContract({
    address: queriedAddress ?? undefined,
    abi: LegacyVaultABI,
    functionName: "checkInInterval",
    query: { enabled: Boolean(queriedAddress) },
  });

  const { data: gracePeriodRaw } = useReadContract({
    address: queriedAddress ?? undefined,
    abi: LegacyVaultABI,
    functionName: "gracePeriod",
    query: { enabled: Boolean(queriedAddress) },
  });

  const { data: contestableWindowRaw } = useReadContract({
    address: queriedAddress ?? undefined,
    abi: LegacyVaultABI,
    functionName: "contestableWindow",
    query: { enabled: Boolean(queriedAddress) },
  });

  const { data: livenessRegistered } = useReadContract({
    address: queriedAddress ?? undefined,
    abi: LegacyVaultABI,
    functionName: "livenessRegistered",
    query: { enabled: Boolean(queriedAddress) },
  });

  // Off-chain display names (vault + owner); falls back to addresses.
  const [vaultMeta, setVaultMeta] = useState<VaultMetaRecord | null>(null);
  useEffect(() => {
    if (!queriedAddress) return;
    let cancelled = false;
    fetchVaultMeta(queriedAddress).then((meta) => {
      if (!cancelled) setVaultMeta(meta);
    });
    return () => {
      cancelled = true;
      setVaultMeta(null);
    };
  }, [queriedAddress]);

  // ── Derived ───────────────────────────────────────────────────────
  const vaultStatus = rawStatus !== undefined ? (Number(rawStatus) as VaultStatus) : null;

  const lastCheckIn = lastCheckInRaw !== undefined ? BigInt(lastCheckInRaw.toString()) : BigInt(0);
  const checkInInterval = intervalRaw !== undefined ? BigInt(intervalRaw.toString()) : BigInt(86400 * 30);
  const gracePeriod = gracePeriodRaw !== undefined ? BigInt(gracePeriodRaw.toString()) : BigInt(86400 * 7);

  const lastCheckInSeconds = lastCheckInRaw !== undefined ? Number(lastCheckInRaw) : 0;
  const ownerAddress = owner ? String(owner) : null;
  const heirTotal = heirCount !== undefined ? Number(heirCount) : null;

  const isLoading = isStatusLoading || isOwnerLoading;
  const showError = queriedAddress && !isLoading && (isStatusError || vaultStatus === null);
  const showResult = queriedAddress && !isLoading && vaultStatus !== null;

  return (
    <div className="landing-canvas" style={{ minHeight: "calc(100vh - var(--header-height, 64px))", padding: "40px 24px 96px" }}>
      <div className="app-container">
        <div style={{ marginBottom: "24px" }}>
          <Link
            href="/"
            className="btn-secondary"
            style={{ padding: "6px 14px", fontSize: "0.8125rem", borderRadius: "0px", borderColor: "rgba(255, 255, 255, 0.2)" }}
          >
            <span>←</span> Home
          </Link>
        </div>

        <div className="panel-instrument" style={{ background: "#000000", border: "1px solid rgba(255, 255, 255, 0.2)" }}>
          {/* Header */}
          <div style={{ padding: "36px 32px 28px", borderBottom: "1px solid rgba(255, 255, 255, 0.12)" }}>
            <h1
              className="section-title"
              style={{ fontSize: "clamp(1.8rem, 3.5vw, 2.6rem)", marginBottom: "10px" }}
            >
              LOOK UP A VAULT
            </h1>
            <p className="section-lead" style={{ fontSize: "0.9375rem" }}>
              Paste a vault address to see if its owner is still checking in. No wallet needed.
            </p>
          </div>

          {/* Search */}
          <div style={{ padding: "28px 32px", borderBottom: "1px solid rgba(255, 255, 255, 0.12)", background: "rgba(255, 255, 255, 0.02)" }}>
            <form onSubmit={handleSearch} style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <input
                type="text"
                className="input-instrument font-data"
                placeholder="Vault address (0x…)"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onPaste={handlePaste}
                style={{
                  flex: "1 1 320px",
                  fontSize: "0.875rem",
                  backgroundColor: "#000000",
                  borderColor: "rgba(255, 255, 255, 0.2)",
                  padding: "12px 16px",
                }}
                autoComplete="off"
                spellCheck={false}
                id="vault-lookup-input"
                aria-label="Vault address"
              />
              <button
                type="submit"
                className="btn-brass"
                style={{ whiteSpace: "nowrap", padding: "12px 28px" }}
                id="vault-lookup-btn"
                disabled={!inputIsValid}
              >
                LOOK UP
              </button>
            </form>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, flexWrap: "wrap", gap: 10 }}>
              {CONTRACT_ADDRESSES.smokeVault && !queriedAddress ? (
                <button
                  type="button"
                  onClick={handleQuickLoadSmoke}
                  style={{ background: "none", border: "none", padding: 0, color: "var(--accent-brass)", fontSize: "0.8125rem", cursor: "pointer" }}
                  id="quick-load-smoke-vault-btn"
                >
                  No address handy? Try an example vault →
                </button>
              ) : (
                <span />
              )}

              {trimmedInput.length > 0 && !inputIsValid && (
                <span style={{ fontSize: "0.75rem", color: "var(--status-amber)" }}>
                  That doesn&apos;t look like an address. It should be 0x followed by 40 characters.
                </span>
              )}
            </div>
          </div>

          {/* Empty state: what a lookup shows */}
          {!queriedAddress && (
            <div style={{ padding: "40px 32px" }}>
              <span className="section-tag">[ WHAT YOU&apos;LL SEE ]</span>
              <dl className="hero-facts" style={{ marginTop: 16, maxWidth: "none" }}>
                {WHAT_YOU_SEE.map((item) => (
                  <div key={item.value} className="hero-fact">
                    <dt className="hero-fact-value" style={{ fontSize: "0.9375rem" }}>{item.value}</dt>
                    <dd className="hero-fact-label">{item.label}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {/* Loading */}
          {queriedAddress && isLoading && <TransparencyLookupSkeleton queriedAddress={queriedAddress} />}

          {/* Not a vault */}
          {showError && (
            <div style={{ padding: "40px 32px" }}>
              <div style={{ background: "rgba(224, 90, 71, 0.1)", border: "1px solid var(--status-red)", padding: "24px" }}>
                <p style={{ fontSize: "1rem", color: "#ffffff", margin: 0, fontWeight: 600 }}>No vault found at this address</p>
                <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginTop: "6px", lineHeight: 1.5 }}>
                  Double-check <span className="font-data" style={{ color: "var(--text-primary)" }}>{shortAddress(queriedAddress)}</span>. Only Legacy vaults on World Chain Sepolia can be looked up.
                </p>
                <div style={{ marginTop: "16px", display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                  <button type="button" onClick={handleReset} className="btn-brass" style={{ fontSize: "0.75rem", padding: "6px 14px" }}>
                    Try another address
                  </button>
                  <a
                    href={`${WORLDSCAN}/${queriedAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-secondary"
                    style={{ fontSize: "0.75rem", padding: "6px 14px" }}
                  >
                    Open on Worldscan ↗
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* Result */}
          {showResult && (
            <div style={{ padding: "32px" }}>
              {/* Who / what this vault is */}
              <div style={{ marginBottom: "24px" }}>
                <h2
                  style={{
                    fontFamily: "'Murs Gothic', var(--font-murs-gothic), sans-serif",
                    fontSize: "1.375rem",
                    color: vaultMeta?.vaultName ? "#ffffff" : "var(--text-secondary)",
                    letterSpacing: "0.03em",
                    margin: 0,
                  }}
                >
                  {vaultMeta?.vaultName ?? `Vault ${shortAddress(queriedAddress)}`}
                </h2>
                <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginTop: 4 }}>
                  Owned by{" "}
                  <span style={{ color: "var(--text-primary)" }}>
                    {vaultMeta?.ownerName ?? (ownerAddress ? shortAddress(ownerAddress) : "unknown")}
                  </span>
                </p>
              </div>

              {/* Big status dial */}
              <div style={{ marginBottom: "28px", paddingBottom: "28px", borderBottom: "1px solid rgba(255, 255, 255, 0.12)" }}>
                <StatusLamp
                  status={vaultStatus}
                  lastCheckIn={lastCheckIn}
                  checkInInterval={checkInInterval}
                  gracePeriod={gracePeriod}
                  livenessRegistered={Boolean(livenessRegistered)}
                />
              </div>

              {/* Facts, in plain language */}
              <div style={{ border: "1px solid rgba(255, 255, 255, 0.12)", padding: "0 24px" }}>
                <FactRow label="Last check-in">
                  {/* The contract seeds lastCheckIn at creation, so it only reflects a real
                      check-in once World ID is registered. */}
                  {livenessRegistered && lastCheckInSeconds > 0 ? (
                    <span title={new Date(lastCheckInSeconds * 1000).toLocaleString()}>{timeAgo(lastCheckInSeconds)}</span>
                  ) : (
                    <span style={{ color: "var(--status-amber)" }}>
                      Never{lastCheckInSeconds > 0 ? ` (created ${timeAgo(lastCheckInSeconds)})` : ""}
                    </span>
                  )}
                </FactRow>
                <FactRow label="Checks in every">
                  {intervalRaw !== undefined ? humanDuration(Number(intervalRaw)) : "—"}
                </FactRow>
                <FactRow label="Grace period after a miss">
                  {gracePeriodRaw !== undefined ? humanDuration(Number(gracePeriodRaw)) : "—"}
                </FactRow>
                <FactRow label="Time to veto a claim">
                  {contestableWindowRaw !== undefined ? humanDuration(Number(contestableWindowRaw)) : "—"}
                </FactRow>
                <FactRow label="Heirs">
                  {heirTotal === null ? "—" : heirTotal === 0 ? "None yet" : String(heirTotal)}
                </FactRow>
                <FactRow label="World ID">
                  <span style={{ color: livenessRegistered ? "var(--status-green)" : "var(--status-amber)" }}>
                    {livenessRegistered ? "Verified" : "Not set up yet"}
                  </span>
                </FactRow>
                <FactRow label="Owner address">
                  {ownerAddress ? (
                    <>
                      <a
                        href={`${WORLDSCAN}/${ownerAddress}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-data"
                        style={{ color: "#ffffff", fontSize: "0.8125rem" }}
                        title={ownerAddress}
                      >
                        {shortAddress(ownerAddress)} ↗
                      </a>
                      <CopyButton value={ownerAddress} />
                    </>
                  ) : (
                    "—"
                  )}
                </FactRow>
                <FactRow label="Vault address">
                  <a
                    href={`${WORLDSCAN}/${queriedAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-data"
                    style={{ color: "#ffffff", fontSize: "0.8125rem" }}
                    title={queriedAddress}
                  >
                    {shortAddress(queriedAddress)} ↗
                  </a>
                  <CopyButton value={queriedAddress} />
                </FactRow>
              </div>

              {/* Actions */}
              <div style={{ display: "flex", gap: "12px", marginTop: "28px", flexWrap: "wrap" }}>
                <Link href={`/claim?v=${queriedAddress}`} className="btn-hero-action" style={{ marginTop: 0 }}>
                  <span>I&apos;M AN HEIR OF THIS VAULT</span>
                  <span className="arrow-icon" aria-hidden="true">→</span>
                </Link>
                <button
                  type="button"
                  onClick={handleReset}
                  className="btn-hero-action btn-hero-action--ghost"
                  style={{ marginTop: 0 }}
                >
                  <span>NEW LOOKUP</span>
                </button>
                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="btn-hero-action btn-hero-action--ghost"
                  style={{ marginTop: 0 }}
                  aria-live="polite"
                >
                  <span>{linkCopied ? "LINK COPIED" : "COPY LINK"}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        <p style={{ textAlign: "center", fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: 24 }}>
          Status is read live from World Chain Sepolia.
        </p>
      </div>
    </div>
  );
}
