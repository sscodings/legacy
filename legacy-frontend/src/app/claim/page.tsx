"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { getAbiItem, isAddress } from "viem";
import { useAccount, useReadContract, useWriteContract, usePublicClient, useChainId, useSwitchChain } from "wagmi";
import { useWalletModal } from "@/components/WalletModal";
import { VaultStatus, ClaimStatus, CONTRACT_ADDRESSES, worldChainSepolia, shortAddress, humanDuration } from "@/lib/constants";
import { fetchVaultMeta, type VaultMetaRecord } from "@/lib/vault-meta/client";
import { LegacyVaultABI } from "@/lib/contracts/abis";
import { ClaimPortalSkeleton } from "@/components/Skeleton";
import { useMounted } from "@/hooks/useMounted";
import { StatusLamp } from "@/components/StatusLamp";
import { SealedMessageHeirPanel } from "@/components/SealedMessageHeirPanel";
import { GuardianAttestationPanel } from "@/components/GuardianAttestationPanel";

interface HeirAllocation {
  assetId: `0x${string}`;
  executor: `0x${string}`;
  executed: boolean;
}

const assetAssignedEvent = getAbiItem({ abi: LegacyVaultABI, name: "AssetAssigned" });

export default function HeirClaimPortal() {
  const mounted = useMounted();
  const { isConnected, isConnecting, isReconnecting, address } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const isWrongChain = isConnected && chainId !== worldChainSepolia.id;
  const { openConnectModal } = useWalletModal();
  const publicClient = usePublicClient();
  const searchParams = useSearchParams();

  const [vaultInput, setVaultInput] = useState<string>("");
  const [vaultAddress, setVaultAddress] = useState<`0x${string}` | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const [isEditingVault, setIsEditingVault] = useState(false);

  // Deep link from the vault dashboard (?v=0x...) — skip the manual paste step
  useEffect(() => {
    const v = searchParams.get("v");
    if (v && isAddress(v)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- prefilling from URL on mount, not a derived-state loop
      setVaultInput(v);
      setVaultAddress(v as `0x${string}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = vaultInput.trim();
    if (!isAddress(trimmed)) {
      setFeedbackMessage({ text: "That doesn't look like a vault address.", isError: true });
      return;
    }
    setFeedbackMessage(null);
    setVaultAddress(trimmed as `0x${string}`);
    setIsEditingVault(false);
  };

  const handleQuickFillSmokeVault = () => {
    setVaultInput(CONTRACT_ADDRESSES.smokeVault);
    setVaultAddress(CONTRACT_ADDRESSES.smokeVault);
    setFeedbackMessage(null);
    setIsEditingVault(false);
  };

  // ── Reads (only when vaultAddress is set) ─────────────────────────
  const { data: rawVaultStatus, isLoading: isStatusLoading, isError: isStatusError, refetch: refetchStatus } = useReadContract({
    address: vaultAddress ?? undefined,
    abi: LegacyVaultABI,
    functionName: "getStatus",
    query: { enabled: Boolean(vaultAddress), refetchInterval: 2000 },
  });

  const { data: isHeirRaw } = useReadContract({
    address: vaultAddress ?? undefined,
    abi: LegacyVaultABI,
    functionName: "isHeir",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(vaultAddress) && Boolean(address) },
  });

  const { data: claimStatusRaw, refetch: refetchClaimStatus } = useReadContract({
    address: vaultAddress ?? undefined,
    abi: LegacyVaultABI,
    functionName: "claimStatus",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(vaultAddress) && Boolean(address), refetchInterval: 2000 },
  });

  const { data: claimInitiatedAtRaw, refetch: refetchInitiatedAt } = useReadContract({
    address: vaultAddress ?? undefined,
    abi: LegacyVaultABI,
    functionName: "claimInitiatedAt",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(vaultAddress) && Boolean(address), refetchInterval: 2000 },
  });

  const { data: contestableWindowRaw } = useReadContract({
    address: vaultAddress ?? undefined,
    abi: LegacyVaultABI,
    functionName: "contestableWindow",
    query: { enabled: Boolean(vaultAddress) },
  });

  const { data: checkInIntervalRaw } = useReadContract({
    address: vaultAddress ?? undefined,
    abi: LegacyVaultABI,
    functionName: "checkInInterval",
    query: { enabled: Boolean(vaultAddress) },
  });

  const { data: gracePeriodRaw } = useReadContract({
    address: vaultAddress ?? undefined,
    abi: LegacyVaultABI,
    functionName: "gracePeriod",
    query: { enabled: Boolean(vaultAddress) },
  });

  const { data: lastCheckInRaw } = useReadContract({
    address: vaultAddress ?? undefined,
    abi: LegacyVaultABI,
    functionName: "lastCheckIn",
    query: { enabled: Boolean(vaultAddress) },
  });

  const { data: vaultOwnerRaw } = useReadContract({
    address: vaultAddress ?? undefined,
    abi: LegacyVaultABI,
    functionName: "owner",
    query: { enabled: Boolean(vaultAddress) },
  });

  const { writeContractAsync } = useWriteContract();

  // Off-chain display names (vault + owner); falls back to addresses.
  const [vaultMeta, setVaultMeta] = useState<VaultMetaRecord | null>(null);
  useEffect(() => {
    if (!vaultAddress) return;
    let cancelled = false;
    fetchVaultMeta(vaultAddress).then((meta) => {
      if (!cancelled) setVaultMeta(meta);
    });
    return () => {
      cancelled = true;
      setVaultMeta(null);
    };
  }, [vaultAddress]);
  const ownerDisplay = vaultMeta?.ownerName ?? (vaultOwnerRaw ? shortAddress(String(vaultOwnerRaw)) : "Unknown");

  // ── Heir's real on-chain allocations (assetId is a keccak256 hash,
  // never guessable — discovered via AssetAssigned logs, not hardcoded) ──
  const [heirAllocations, setHeirAllocations] = useState<HeirAllocation[]>([]);
  const [isLoadingAllocations, setIsLoadingAllocations] = useState(false);

  const refetchAllocations = useCallback(async () => {
    if (!publicClient || !vaultAddress || !address || !assetAssignedEvent) return;
    try {
      setIsLoadingAllocations(true);
      const logs = await publicClient.getLogs({
        address: vaultAddress,
        event: assetAssignedEvent,
        args: { heir: address },
        fromBlock: 0n,
        toBlock: "latest",
      });

      const assetIds = Array.from(
        new Set(logs.map((log) => log.args.assetId).filter((id): id is `0x${string}` => Boolean(id)))
      );

      const results = await Promise.all(
        assetIds.map(async (assetId) => {
          const alloc = await publicClient.readContract({
            address: vaultAddress,
            abi: LegacyVaultABI,
            functionName: "allocations",
            args: [assetId],
          });
          // allocations() returns [heir, executor, assetId, exists, executed]
          const [, executor, , exists, executed] = alloc as unknown as [
            `0x${string}`,
            `0x${string}`,
            `0x${string}`,
            boolean,
            boolean
          ];
          return exists ? { assetId, executor, executed } : null;
        })
      );

      setHeirAllocations(results.filter((r): r is HeirAllocation => r !== null));
    } catch (err) {
      console.error("❌ [Claim] Failed to load heir allocations:", err);
    } finally {
      setIsLoadingAllocations(false);
    }
  }, [publicClient, vaultAddress, address]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch of on-chain logs, not a sync setState
    refetchAllocations();
  }, [refetchAllocations]);

  // ── Derived state ─────────────────────────────────────────────────
  const vaultStatus =
    rawVaultStatus !== undefined ? (Number(rawVaultStatus) as VaultStatus) : null;
  const isHeir = Boolean(isHeirRaw);
  const claimStatus =
    claimStatusRaw !== undefined ? (Number(claimStatusRaw) as ClaimStatus) : ClaimStatus.NotInitiated;
  const claimInitiatedAt =
    claimInitiatedAtRaw !== undefined ? BigInt(claimInitiatedAtRaw.toString()) : BigInt(0);
  const contestableWindow =
    contestableWindowRaw !== undefined ? BigInt(contestableWindowRaw.toString()) : BigInt(3600 * 48);
  const checkInInterval =
    checkInIntervalRaw !== undefined ? BigInt(checkInIntervalRaw.toString()) : BigInt(86400 * 30);
  const gracePeriod =
    gracePeriodRaw !== undefined ? BigInt(gracePeriodRaw.toString()) : BigInt(86400 * 7);
  const lastCheckIn =
    lastCheckInRaw !== undefined ? BigInt(lastCheckInRaw.toString()) : BigInt(0);

  const [windowRemainingSec, setWindowRemainingSec] = useState<number | null>(null);
  const [invalidated, setInvalidated] = useState(false);
  const canFinalize = windowRemainingSec !== null && windowRemainingSec <= 0 && !invalidated;

  useEffect(() => {
    const update = () => {
      if (claimStatus !== ClaimStatus.Contestable || claimInitiatedAt === BigInt(0)) {
        setWindowRemainingSec(null);
        setInvalidated(false);
        return;
      }
      if (Number(lastCheckIn) >= Number(claimInitiatedAt)) {
        setInvalidated(true);
        setWindowRemainingSec(0);
        return;
      }
      setInvalidated(false);
      const now = Math.floor(Date.now() / 1000);
      const endsAt = Number(claimInitiatedAt) + Number(contestableWindow);
      setWindowRemainingSec(endsAt - now);
    };
    update();
    const iv = setInterval(update, 1000);
    return () => clearInterval(iv);
  }, [claimStatus, claimInitiatedAt, contestableWindow, lastCheckIn]);

  // ── Write handlers ─────────────────────────────────────────────────
  const handleInitiateClaim = async () => {
    if (!publicClient || !vaultAddress) return;
    try {
      setIsProcessing(true);
      setFeedbackMessage(null);
      if (isWrongChain && switchChain) {
        await switchChain({ chainId: worldChainSepolia.id });
      }
      const hash = await writeContractAsync({
        chainId: worldChainSepolia.id,
        address: vaultAddress,
        abi: LegacyVaultABI,
        functionName: "initiateClaim",
        gas: 250000n,
      });
      await publicClient.waitForTransactionReceipt({ hash });

      // Notify the owner immediately via the automated notification network
      fetch("/api/notifications/claim-alert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vaultAddress,
          heirAddress: address,
          txHash: hash,
        }),
      }).catch((notifyErr) => {
        console.warn("[Notification] Error triggering claim alert:", notifyErr);
      });

      setFeedbackMessage({ text: "Claim started. The owner can still cancel it by checking in.", isError: false });
      refetchClaimStatus();
      refetchInitiatedAt();
      refetchStatus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      let translated = msg;
      if (msg.includes("VaultNotRed")) {
        translated = "This vault isn't in claims-open status yet.";
      } else if (msg.includes("HeirNotRegistered")) {
        translated = "Your wallet isn't a registered heir of this vault.";
      } else if (msg.includes("ClaimAlreadyInitiated")) {
        translated = "You already have an active claim on this vault.";
      } else if (msg.includes("gas limit") || msg.includes("0x12c1") || msg.includes("rejected") || msg.includes("denied")) {
        translated = "Couldn't start the claim. Make sure the vault is in claims-open status and you're an authorized heir.";
      }
      setFeedbackMessage({ text: translated, isError: true });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFinalizeClaim = async () => {
    if (!publicClient || !vaultAddress) return;
    try {
      setIsProcessing(true);
      setFeedbackMessage(null);
      if (isWrongChain && switchChain) {
        await switchChain({ chainId: worldChainSepolia.id });
      }
      const hash = await writeContractAsync({
        chainId: worldChainSepolia.id,
        address: vaultAddress,
        abi: LegacyVaultABI,
        functionName: "finalizeClaim",
        gas: 250000n,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setFeedbackMessage({ text: "Claim finalized. You can now transfer your assets below.", isError: false });
      refetchClaimStatus();
      refetchStatus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      let translated = msg;
      if (msg.includes("ContestableWindowNotElapsed")) {
        translated = "The waiting period hasn't ended yet.";
      } else if (msg.includes("ClaimNotContestable")) {
        translated = "This claim isn't open, or it was cancelled by an owner check-in.";
      } else if (msg.includes("VaultNotRed")) {
        translated = "This vault isn't in claims-open status.";
      } else if (msg.includes("HeirNotRegistered")) {
        translated = "Your wallet isn't an authorized heir.";
      }
      setFeedbackMessage({ text: translated, isError: true });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExecuteAsset = async (assetId: `0x${string}`) => {
    if (!publicClient || !vaultAddress) return;
    try {
      setIsProcessing(true);
      setFeedbackMessage(null);
      if (isWrongChain && switchChain) {
        await switchChain({ chainId: worldChainSepolia.id });
      }
      const hash = await writeContractAsync({
        chainId: worldChainSepolia.id,
        address: vaultAddress,
        abi: LegacyVaultABI,
        functionName: "executeClaim",
        args: [assetId],
        gas: 450000n,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setFeedbackMessage({ text: "Asset transferred to your wallet.", isError: false });
      refetchAllocations();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to execute claim";
      let translated = msg;
      if (msg.includes("AssetNotAssigned")) {
        translated = "This asset is no longer assigned on the vault.";
      } else if (msg.includes("AssetAlreadyClaimed")) {
        translated = "This asset was already transferred.";
      } else if (msg.includes("ClaimNotFinalized")) {
        translated = "Finalize your claim before transferring assets.";
      } else if (msg.includes("NotAssignedHeir")) {
        translated = "This asset isn't assigned to your wallet.";
      }
      setFeedbackMessage({ text: translated, isError: true });
    } finally {
      setIsProcessing(false);
    }
  };

  // ── Safe SSR & Mounting State ─────────────────────────────────────
  if (!mounted || isConnecting || isReconnecting) {
    return <ClaimPortalSkeleton />;
  }

  const backRow = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "4px 0" }}>
      <Link href="/" className="flow-link" style={{ fontSize: "0.8125rem" }}>
        ← Home
      </Link>
      {vaultAddress && isConnected && !isEditingVault && (
        <button
          type="button"
          onClick={() => {
            setVaultInput(vaultAddress);
            setIsEditingVault(true);
          }}
          className="flow-link"
          style={{ fontSize: "0.8125rem", background: "none", border: "none", cursor: "pointer" }}
        >
          Change vault
        </button>
      )}
    </div>
  );

  // ── Not Connected State ───────────────────────────────────────────
  if (!isConnected) {
    return (
      <div className="landing-canvas vault-console" style={{ minHeight: "calc(100vh - var(--header-height, 64px))", padding: "32px 24px 96px" }}>
        <div className="vault-console-layout">
          {backRow}
          <div className="console-card" style={{ padding: "36px" }}>
            <div className="panel-stack">
              <div>
                <h1 className="panel-title" style={{ fontSize: "1.5rem" }}>
                  Claim your inheritance
                </h1>
                <p className="panel-lead">
                  If someone named you an heir on a Legacy vault, connect your wallet to check its status.
                </p>
              </div>
              <div>
                <button type="button" onClick={openConnectModal} className="flow-btn" id="heir-connect-btn">
                  Connect wallet
                </button>
              </div>
              <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", margin: 0 }}>
                Only want to see whether a vault is still active?{" "}
                <Link
                  href={vaultAddress ? `/lookup?v=${vaultAddress}` : "/lookup"}
                  className="flow-link"
                >
                  Look it up without a wallet
                </Link>
                .
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const showPicker = !vaultAddress || isEditingVault;
  const showLoaded = vaultAddress && !isStatusLoading && !isStatusError && vaultStatus !== null;
  const showLoading = vaultAddress && !isEditingVault && isStatusLoading && vaultStatus === null;
  const showNotFound = vaultAddress && !isEditingVault && !isStatusLoading && (isStatusError || vaultStatus === null);

  const statusPill =
    vaultStatus === null
      ? null
      : isHeir
      ? { label: "You're an authorized heir", color: "var(--status-green)" }
      : { label: "You're not on the heir list", color: "var(--text-secondary)" };

  return (
    <div className="landing-canvas vault-console" style={{ minHeight: "calc(100vh - var(--header-height, 64px))", padding: "32px 24px 96px" }}>
      <div className="vault-console-layout">
        {backRow}

        {isWrongChain && (
          <div className="console-alert console-alert--warning">
            <div className="console-alert-body">
              <strong>Wrong network</strong>
              <p>Switch to World Chain Sepolia to check vault status and claim assets.</p>
            </div>
            <button type="button" onClick={() => switchChain?.({ chainId: worldChainSepolia.id })} className="flow-btn">
              Switch network
            </button>
          </div>
        )}

        {showPicker && (
          <div className="console-card" style={{ padding: "28px 32px" }}>
            <form onSubmit={handleSearch} className="panel-stack" style={{ gap: 16 }}>
              <div>
                <h1 className="panel-title" style={{ fontSize: "1.25rem" }}>
                  Load a vault
                </h1>
                <p className="panel-lead">Paste the vault address you were given.</p>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <input
                  id="vault-address-input"
                  type="text"
                  className="flow-input"
                  placeholder="Vault address (0x…)"
                  value={vaultInput}
                  onChange={(e) => setVaultInput(e.target.value)}
                  style={{ flex: "1 1 260px" }}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus={isEditingVault}
                />
                <button type="submit" className="flow-btn" id="lookup-vault-btn">
                  Load vault
                </button>
                {vaultAddress && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsEditingVault(false);
                      setFeedbackMessage(null);
                    }}
                    className="flow-btn flow-btn--ghost"
                  >
                    Cancel
                  </button>
                )}
              </div>
              <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
                <button type="button" onClick={handleQuickFillSmokeVault} className="flow-link" style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}>
                  Try an example vault
                </button>
                {" · "}
                <Link href="/vault" className="flow-link">
                  Check your dashboard
                </Link>
              </p>
            </form>
          </div>
        )}

        {showLoading && (
          <div className="console-card" style={{ padding: "32px", display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
            <div className="skeleton-shimmer" style={{ width: 160, height: 160, borderRadius: "50%" }} />
            <div className="skeleton-shimmer" style={{ width: "45%", height: 20 }} />
            <div className="skeleton-shimmer" style={{ width: "65%", height: 14 }} />
          </div>
        )}

        {showNotFound && (
          <div className="console-card" style={{ padding: "32px" }}>
            <p style={{ margin: 0, fontSize: "1rem", color: "#ffffff", fontWeight: 600 }}>No vault found at this address</p>
            <p style={{ margin: "6px 0 16px", fontSize: "0.875rem", color: "var(--text-secondary)" }}>
              Double-check <span className="font-data">{shortAddress(vaultAddress!)}</span>, or try the example vault.
            </p>
            <button type="button" onClick={handleQuickFillSmokeVault} className="flow-btn">
              Try an example vault
            </button>
          </div>
        )}

        {showLoaded && (
          <>
            {/* Identity + status: the same big dial the owner sees */}
            <section className="console-card" style={{ padding: "32px 36px", display: "flex", flexDirection: "column", alignItems: "center", gap: 18, textAlign: "center" }}>
              <div>
                <h2 style={{ margin: 0, fontFamily: "'Murs Gothic', var(--font-murs-gothic), sans-serif", fontSize: "1.25rem", color: "#ffffff" }}>
                  {vaultMeta?.vaultName ?? `Vault ${shortAddress(vaultAddress!)}`}
                </h2>
                <p style={{ margin: "4px 0 0", fontSize: "0.8125rem", color: "var(--text-secondary)" }}>from {ownerDisplay}</p>
              </div>

              <StatusLamp status={vaultStatus} lastCheckIn={lastCheckIn} checkInInterval={checkInInterval} gracePeriod={gracePeriod} livenessRegistered={true} />

              {statusPill && (
                <span className="state-pill">
                  <span className="network-dot" style={{ backgroundColor: statusPill.color }} />
                  {statusPill.label}
                </span>
              )}
            </section>

            {/* Action area: what the connected heir can do right now */}
            <section className="console-card">
              <div className="console-tabpanel">
                {claimStatus === ClaimStatus.Contestable ? (
                  <div className="panel-stack" style={{ alignItems: "center", textAlign: "center" }}>
                    <span className="state-pill">
                      <span className="network-dot" style={{ backgroundColor: "var(--status-amber)" }} />
                      Waiting period active
                    </span>
                    {invalidated ? (
                      <h3 className="panel-title" style={{ fontSize: "1.25rem" }}>
                        Cancelled — the owner checked in
                      </h3>
                    ) : (
                      <>
                        <div>
                          <div className="status-dial-label">Unlocks in</div>
                          <div className="status-dial-time font-data" style={{ fontSize: "2rem" }} aria-live="polite">
                            {windowRemainingSec !== null && windowRemainingSec > 0 ? humanDuration(windowRemainingSec) : "0 seconds"}
                          </div>
                        </div>
                        <p className="panel-lead">The owner can still cancel this by checking in.</p>
                        <button type="button" onClick={handleFinalizeClaim} disabled={!canFinalize || isProcessing} className="flow-btn">
                          {isProcessing ? "Finalizing…" : "Finalize claim"}
                        </button>
                      </>
                    )}
                  </div>
                ) : claimStatus === ClaimStatus.Claimed ? (
                  <div className="panel-stack">
                    <h3 className="panel-title" style={{ fontSize: "1.25rem" }}>
                      Claim finalized — transfer your assets
                    </h3>

                    {isLoadingAllocations ? (
                      <div className="skeleton-shimmer" style={{ width: "100%", height: 80 }} />
                    ) : heirAllocations.length === 0 ? (
                      <div className="panel-empty">No assets are currently assigned to your wallet.</div>
                    ) : (
                      <div className="setting-list">
                        {heirAllocations.map((alloc) => (
                          <div key={alloc.assetId} className="setting-row">
                            <div className="setting-label">
                              <strong className="font-data" style={{ fontWeight: 600 }}>
                                {alloc.assetId.slice(0, 10)}…{alloc.assetId.slice(-8)}
                              </strong>
                              <span className="font-data">
                                {alloc.executor.slice(0, 8)}…{alloc.executor.slice(-6)}
                                {alloc.executed ? " · transferred" : ""}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleExecuteAsset(alloc.assetId)}
                              disabled={isProcessing || alloc.executed}
                              className="flow-btn"
                            >
                              {alloc.executed ? "Transferred" : isProcessing ? "Transferring…" : "Transfer"}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="panel-stack" style={{ alignItems: "center", textAlign: "center" }}>
                    {vaultStatus !== VaultStatus.Red ? (
                      <h3 className="panel-title" style={{ fontSize: "1.25rem" }}>
                        Nothing to do yet
                      </h3>
                    ) : isHeir ? (
                      <>
                        <h3 className="panel-title" style={{ fontSize: "1.25rem" }}>
                          Ready to claim
                        </h3>
                        <button type="button" onClick={handleInitiateClaim} disabled={isProcessing} className="flow-btn" id="initiate-claim-btn">
                          {isProcessing ? "Starting…" : "Start claim"}
                        </button>
                      </>
                    ) : (
                      <p className="panel-lead" style={{ margin: 0 }}>
                        Claims are open, but this wallet isn&apos;t on the heir list.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* Guardian death-attestation vote (accelerates inheritance). */}
            <GuardianAttestationPanel vaultAddress={vaultAddress} viewerAddress={address} />

            {/* Encrypted message the owner sealed to this heir. */}
            {address && <SealedMessageHeirPanel vaultAddress={vaultAddress} heirAddress={address} isHeir={isHeir} />}
          </>
        )}

        {feedbackMessage && (
          <div className={`panel-note ${feedbackMessage.isError ? "panel-note--error" : "panel-note--success"}`}>{feedbackMessage.text}</div>
        )}
      </div>
    </div>
  );
}
