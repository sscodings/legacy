"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getAbiItem } from "viem";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { VaultStatus, VAULT_STATUS_COPY, shortAddress } from "@/lib/constants";
import { LegacyVaultABI } from "@/lib/contracts/abis";
import { fetchVaultMeta, fetchVaultMetasByOwner } from "@/lib/vault-meta/client";

interface VaultDashboardHubProps {
  ownedVaults: readonly `0x${string}`[];
  isLoadingOwned: boolean;
  onManageVault: (vault: `0x${string}`) => void;
  onCreateVault: () => void;
  isCreatingVault: boolean;
  isWrongChain: boolean;
  onSwitchChain: () => void;
}

interface HeirVaultEntry {
  vault: `0x${string}`;
  status: VaultStatus;
  owner: `0x${string}`;
  vaultName?: string;
  ownerName?: string;
}

const heirAddedEvent = getAbiItem({ abi: LegacyVaultABI, name: "HeirAdded" });
const guardianAddedEvent = getAbiItem({ abi: LegacyVaultABI, name: "GuardianAdded" });

function StatusDot({ status }: { status: VaultStatus | null }) {
  const copy = status !== null ? VAULT_STATUS_COPY[status] : null;
  const color = copy?.color ?? "var(--text-secondary)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          backgroundColor: color,
          boxShadow: copy ? `0 0 6px ${color}` : "none",
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: "0.75rem", fontWeight: 600, color }}>{copy?.label ?? "Loading…"}</span>
    </span>
  );
}

// Stagger caps at 8 cards worth of delay so large lists don't drag out the entrance.
const MAX_STAGGER_INDEX = 8;
const STAGGER_STEP_MS = 40;

function cardStaggerStyle(index: number): React.CSSProperties {
  const delay = Math.min(index, MAX_STAGGER_INDEX) * STAGGER_STEP_MS;
  return { animationDelay: `${delay}ms` };
}

function VaultCard({
  vaultAddress,
  vaultName,
  status,
  detail,
  ctaLabel,
  onClick,
  urgent,
  style,
}: {
  vaultAddress: `0x${string}`;
  vaultName?: string;
  status: VaultStatus | null;
  /** One human line under the name, e.g. "From Maria Chen" or "2 heirs". */
  detail: string;
  ctaLabel: string;
  onClick: () => void;
  urgent?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="vault-card animate-fade-up"
      style={{
        textAlign: "left",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "20px",
        backgroundColor: urgent ? "rgba(193, 80, 63, 0.06)" : "rgba(255, 255, 255, 0.02)",
        border: `1px solid ${urgent ? "var(--status-red)" : "rgba(255, 255, 255, 0.1)"}`,
        cursor: "pointer",
        width: "100%",
        borderRadius: 0,
        ...style,
      }}
    >
      <StatusDot status={status} />
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <div
          style={{
            fontFamily: "'Murs Gothic', var(--font-murs-gothic), sans-serif",
            fontSize: "1.0625rem",
            color: vaultName ? "#ffffff" : "var(--text-secondary)",
            letterSpacing: "0.02em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={vaultAddress}
        >
          {vaultName ?? `Vault ${shortAddress(vaultAddress)}`}
        </div>
        <div style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>{detail}</div>
      </div>
      <div style={{ fontSize: "0.75rem", color: "var(--accent-brass)", fontWeight: 600 }}>
        {ctaLabel} →
      </div>
    </button>
  );
}

/** "From Maria Chen", falling back to a short owner address when unnamed. */
function fromOwner(entry: HeirVaultEntry) {
  return `From ${entry.ownerName ?? shortAddress(entry.owner)}`;
}

function CardSkeleton() {
  return (
    <div className="animate-fade-up" style={{ display: "flex", flexDirection: "column", gap: 10, padding: "18px 20px", border: "1px solid rgba(255, 255, 255, 0.08)" }}>
      <div className="skeleton-shimmer" style={{ width: 60, height: 12 }} />
      <div className="skeleton-shimmer" style={{ width: "70%", height: 16 }} />
      <div className="skeleton-shimmer" style={{ width: "40%", height: 12 }} />
    </div>
  );
}

export function VaultDashboardHub({
  ownedVaults,
  isLoadingOwned,
  onManageVault,
  onCreateVault,
  isCreatingVault,
  isWrongChain,
  onSwitchChain,
}: VaultDashboardHubProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const router = useRouter();

  // ── Owned vaults: live status + heir count via multicall ──────────
  const ownedContracts = ownedVaults.flatMap((v) => [
    { address: v, abi: LegacyVaultABI, functionName: "getStatus" as const },
    { address: v, abi: LegacyVaultABI, functionName: "getHeirCount" as const },
  ]);

  const { data: ownedResults } = useReadContracts({
    contracts: ownedContracts,
    query: { enabled: ownedVaults.length > 0, refetchInterval: 5000 },
  });

  // Off-chain vault names for owned vaults (best-effort; falls back to address)
  const [vaultNames, setVaultNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    fetchVaultMetasByOwner(address).then((metas) => {
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const m of metas) {
        if (m.vaultName) map[m.vaultAddress.toLowerCase()] = m.vaultName;
      }
      setVaultNames(map);
    });
    return () => {
      cancelled = true;
    };
  }, [address, ownedVaults.length]);

  const ownedCards = ownedVaults.map((v, i) => {
    const statusRes = ownedResults?.[i * 2];
    const heirCountRes = ownedResults?.[i * 2 + 1];
    return {
      vault: v,
      status: statusRes?.status === "success" ? (Number(statusRes.result) as VaultStatus) : null,
      heirCount: heirCountRes?.status === "success" ? Number(heirCountRes.result) : null,
      name: vaultNames[v.toLowerCase()],
    };
  });

  // ── Heir-side discovery: scan HeirAdded logs for this address across
  // every vault, then confirm current membership (handles removals) ──
  const [heirVaults, setHeirVaults] = useState<HeirVaultEntry[]>([]);
  const [isLoadingHeirVaults, setIsLoadingHeirVaults] = useState(false);
  const [heirScanError, setHeirScanError] = useState<string | null>(null);

  const scanHeirVaults = useCallback(async () => {
    if (!publicClient || !address || !heirAddedEvent) return;
    try {
      setIsLoadingHeirVaults(true);
      setHeirScanError(null);
      const logs = await publicClient.getLogs({
        event: heirAddedEvent,
        args: { heir: address },
        fromBlock: 0n,
        toBlock: "latest",
      });
      const candidates = Array.from(new Set(logs.map((l) => l.address)));

      const results = await Promise.all(
        candidates.map(async (vault): Promise<HeirVaultEntry | null> => {
          const [isHeirNow, statusNow, ownerNow] = await Promise.all([
            publicClient.readContract({ address: vault, abi: LegacyVaultABI, functionName: "isHeir", args: [address] }),
            publicClient.readContract({ address: vault, abi: LegacyVaultABI, functionName: "getStatus" }),
            publicClient.readContract({ address: vault, abi: LegacyVaultABI, functionName: "owner" }),
          ]);
          if (!isHeirNow) return null;
          const meta = await fetchVaultMeta(vault);
          return {
            vault,
            status: Number(statusNow) as VaultStatus,
            owner: ownerNow as `0x${string}`,
            vaultName: meta?.vaultName,
            ownerName: meta?.ownerName,
          };
        })
      );

      setHeirVaults(results.filter((r): r is HeirVaultEntry => r !== null));
    } catch (err) {
      console.error("❌ [Dashboard] Failed to scan for beneficiary vaults:", err);
      setHeirScanError("Could not scan for beneficiary vaults automatically. Your RPC endpoint may restrict this type of query — use manual lookup below instead.");
    } finally {
      setIsLoadingHeirVaults(false);
    }
  }, [publicClient, address]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async log scan, not a sync setState
    scanHeirVaults();
  }, [scanHeirVaults]);

  // ── Guardian-side discovery: scan GuardianAdded logs for this address,
  // then confirm current guardianship (handles removals) ──
  const [guardianVaults, setGuardianVaults] = useState<HeirVaultEntry[]>([]);
  const [isLoadingGuardianVaults, setIsLoadingGuardianVaults] = useState(false);

  const scanGuardianVaults = useCallback(async () => {
    if (!publicClient || !address || !guardianAddedEvent) return;
    try {
      setIsLoadingGuardianVaults(true);
      const logs = await publicClient.getLogs({
        event: guardianAddedEvent,
        args: { guardian: address },
        fromBlock: 0n,
        toBlock: "latest",
      });
      const candidates = Array.from(new Set(logs.map((l) => l.address)));

      const results = await Promise.all(
        candidates.map(async (vault): Promise<HeirVaultEntry | null> => {
          const [isGuardianNow, statusNow, ownerNow] = await Promise.all([
            publicClient.readContract({ address: vault, abi: LegacyVaultABI, functionName: "isGuardian", args: [address] }),
            publicClient.readContract({ address: vault, abi: LegacyVaultABI, functionName: "getStatus" }),
            publicClient.readContract({ address: vault, abi: LegacyVaultABI, functionName: "owner" }),
          ]);
          if (!isGuardianNow) return null;
          const meta = await fetchVaultMeta(vault);
          return {
            vault,
            status: Number(statusNow) as VaultStatus,
            owner: ownerNow as `0x${string}`,
            vaultName: meta?.vaultName,
            ownerName: meta?.ownerName,
          };
        })
      );

      setGuardianVaults(results.filter((r): r is HeirVaultEntry => r !== null));
    } catch (err) {
      console.error("❌ [Dashboard] Failed to scan for guardian vaults:", err);
    } finally {
      setIsLoadingGuardianVaults(false);
    }
  }, [publicClient, address]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async log scan, not a sync setState
    scanGuardianVaults();
  }, [scanGuardianVaults]);

  const hasOwned = ownedVaults.length > 0;

  return (
    <div style={{ padding: "32px", display: "flex", flexDirection: "column", gap: "40px" }}>
      {/* Header row: title + CTA, always visible, no scrolling required */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "16px" }}>
        <div>
          <h1 className="section-title" style={{ fontSize: "1.625rem", marginBottom: "6px" }}>
            YOUR VAULTS
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", maxWidth: 520, lineHeight: 1.5 }}>
            What you&apos;re leaving behind, and what&apos;s been left to you.
          </p>
        </div>
        {/* With no vault yet, the empty state below carries the one create action */}
        {(hasOwned || isLoadingOwned || isWrongChain) && (
          <button
            type="button"
            onClick={isWrongChain ? onSwitchChain : onCreateVault}
            disabled={isCreatingVault}
            className={isWrongChain ? "btn-chain-wrong" : "btn-hero-action"}
            style={{ marginTop: 0, padding: "12px 24px", flexShrink: 0 }}
          >
            <span>
              {isCreatingVault ? "Deploying…" : isWrongChain ? "Switch Network" : "+ Create New Vault"}
            </span>
            {!isCreatingVault && !isWrongChain && <span className="arrow-icon" aria-hidden="true">→</span>}
          </button>
        )}
      </div>

      {/* ── Your Vaults ─────────────────────────────────────────── */}
      <section>
        <h2 style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: "16px" }}>
          You own {hasOwned ? `(${ownedVaults.length})` : ""}
        </h2>

        {isLoadingOwned ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "14px" }}>
            <CardSkeleton />
            <CardSkeleton />
          </div>
        ) : !hasOwned ? (
          <div
            style={{
              padding: "28px 24px",
              border: "1px dashed rgba(255, 255, 255, 0.15)",
              backgroundColor: "rgba(255, 255, 255, 0.01)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "16px",
            }}
          >
            <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", margin: 0, lineHeight: 1.5, maxWidth: 420 }}>
              You don&apos;t have a vault yet. Create one, add your heirs, and check in now and then. That&apos;s it.
            </p>
            <button
              type="button"
              onClick={isWrongChain ? onSwitchChain : onCreateVault}
              disabled={isCreatingVault}
              className={isWrongChain ? "btn-chain-wrong" : "btn-hero-action"}
              style={{ marginTop: 0, padding: "12px 24px", flexShrink: 0 }}
            >
              {isCreatingVault ? "Deploying…" : isWrongChain ? "Switch Network" : "+ Create your first vault"}
            </button>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "14px" }}>
            {ownedCards.map((card, i) => (
              <VaultCard
                key={card.vault}
                vaultAddress={card.vault}
                vaultName={card.name}
                status={card.status}
                detail={
                  card.heirCount === null
                    ? "Loading heirs…"
                    : card.heirCount === 0
                      ? "No heirs yet"
                      : `${card.heirCount} heir${card.heirCount === 1 ? "" : "s"}`
                }
                ctaLabel="Open"
                onClick={() => onManageVault(card.vault)}
                style={cardStaggerStyle(i)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Vaults You're a Beneficiary Of ──────────────────────── */}
      <section>
        <h2 style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: "16px" }}>
          Left to you {heirVaults.length > 0 ? `(${heirVaults.length})` : ""}
        </h2>

        {isLoadingHeirVaults ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "14px" }}>
            <CardSkeleton />
          </div>
        ) : heirVaults.length === 0 ? (
          <div
            style={{
              padding: "24px",
              border: "1px solid rgba(255, 255, 255, 0.08)",
              backgroundColor: "rgba(255, 255, 255, 0.01)",
            }}
          >
            <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", margin: 0, lineHeight: 1.5 }}>
              Nobody has named you as an heir yet.
            </p>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "14px" }}>
            {heirVaults.map((entry, i) => (
              <VaultCard
                key={entry.vault}
                vaultAddress={entry.vault}
                vaultName={entry.vaultName}
                status={entry.status}
                detail={fromOwner(entry)}
                ctaLabel={entry.status === VaultStatus.Red ? "Start claim" : "View"}
                onClick={() => router.push(`/claim?v=${entry.vault}`)}
                urgent={entry.status === VaultStatus.Red}
                style={cardStaggerStyle(i)}
              />
            ))}
          </div>
        )}

        {heirScanError && (
          <p style={{ color: "var(--status-amber)", fontSize: "0.75rem", marginTop: "10px", lineHeight: 1.5 }}>
            {heirScanError}
          </p>
        )}

        <p style={{ color: "var(--text-secondary)", fontSize: "0.75rem", marginTop: "10px" }}>
          Missing a vault?{" "}
          <Link href="/claim" style={{ color: "var(--accent-brass)" }}>
            Look it up by address →
          </Link>
        </p>
      </section>

      {/* ── Vaults You Safeguard (guardian) ─────────────────────── */}
      {(isLoadingGuardianVaults || guardianVaults.length > 0) && (
        <section>
          <h2 style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: "16px" }}>
            You&apos;re a guardian for {guardianVaults.length > 0 ? `(${guardianVaults.length})` : ""}
          </h2>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.8125rem", marginTop: "-8px", marginBottom: "16px", lineHeight: 1.5, maxWidth: 560 }}>
            These owners trust you to confirm if they pass away. When every guardian confirms, their heirs can inherit almost immediately.
          </p>

          {isLoadingGuardianVaults ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "14px" }}>
              <CardSkeleton />
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "14px" }}>
              {guardianVaults.map((entry, i) => (
                <VaultCard
                  key={entry.vault}
                  vaultAddress={entry.vault}
                  vaultName={entry.vaultName}
                  status={entry.status}
                  detail={fromOwner(entry)}
                  ctaLabel="Review"
                  onClick={() => router.push(`/claim?v=${entry.vault}`)}
                  urgent={entry.status === VaultStatus.Red}
                  style={cardStaggerStyle(i)}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
