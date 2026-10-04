"use client";

import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import { useAccount, useReadContract, useWriteContract, usePublicClient, useChainId, useSwitchChain } from "wagmi";
import { useWalletModal } from "@/components/WalletModal";
import {
  CONTRACT_ADDRESSES,
  VaultStatus,
  worldChainSepolia,
  shortAddress,
} from "@/lib/constants";
import { BaseError, ContractFunctionRevertedError, getAddress, isAddress, isAddressEqual } from "viem";
import { LegacyVaultFactoryABI, LegacyVaultABI, WorldIDRevertErrorsABI } from "@/lib/contracts/abis";
import { VaultDashboardHub } from "@/components/VaultDashboardHub";
import { LivenessPanel } from "@/components/LivenessPanel";
import { SealedMessagePanel } from "@/components/SealedMessagePanel";
import { ActivityLog } from "@/components/ActivityLog";
import { CheckInModal } from "@/components/CheckInModal";
import { HeirList } from "@/components/HeirList";
import { GuardianList } from "@/components/GuardianList";
import { AssetList, AssetRecord } from "@/components/AssetList";
import {
  loadVaultAllocations,
  assessAllocations,
  summarizeHealth,
  type AllocationHealth,
} from "@/lib/health/allocation-health";
import { VaultParameters } from "@/components/VaultParameters";
import { WatchdogAlertPanel } from "@/components/WatchdogAlertPanel";
import {
  VaultDashboardSkeleton,
  LivenessPanelSkeleton,
} from "@/components/Skeleton";
import {
  VaultDeploymentModal,
  DeploymentStage,
} from "@/components/VaultDeploymentModal";
import { VaultCreationModal } from "@/components/VaultCreationModal";
import { VaultIdentityBar } from "@/components/VaultIdentityBar";
import {
  fetchVaultMeta,
  saveVaultNames,
  fetchVaultMetasByOwner,
  saveHeirName,
  removeHeirName as removeHeirNameMeta,
  heirNameMap,
  type VaultMetaRecord,
} from "@/lib/vault-meta/client";
import { useMounted } from "@/hooks/useMounted";

// LegacyVault ABI plus the World ID errors that bubble up through
// registerLiveness / checkIn, so simulated reverts decode to a named error.
const LivenessCallABI = [...LegacyVaultABI, ...WorldIDRevertErrorsABI] as const;

const LIVENESS_REVERT_MESSAGES: Record<string, string> = {
  ProofInvalid:
    "ProofInvalid: The World ID proof was rejected by this vault's verifier. Vaults bound to the production World ID router reject staging/simulator proofs. Deploy a new vault on the testnet verifier.",
  NonExistentRoot: "NonExistentRoot: The proof's Merkle root is unknown to this vault's World ID verifier.",
  ExpiredRoot: "ExpiredRoot: The proof's Merkle root has expired. Generate a fresh World ID proof.",
  LivenessAlreadyRegistered: "LivenessAlreadyRegistered: This vault already has an enrolled identity.",
  AlreadyRegistered: "AlreadyRegistered: The verifier already holds a nullifier for this vault.",
  LivenessNotRegistered: "LivenessNotRegistered: Register liveness before checking in.",
  NotOwner: "NotOwner: Only the vault owner can submit liveness proofs.",
};

// Simulates a liveness call so a bad proof fails before broadcast (the real
// tx uses a fixed gas limit, which skips estimation) and the revert is named.
async function assertLivenessCallSucceeds(
  simulate: () => Promise<unknown>,
  functionName: string
): Promise<void> {
  try {
    await simulate();
  } catch (err: unknown) {
    const revert =
      err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? revert.signature ?? "unknown";
      console.error(`❌ [Vault] ${functionName} simulation reverted:`, name, err);
      throw new Error(LIVENESS_REVERT_MESSAGES[name] ?? `${functionName} would revert on-chain: ${name}`);
    }
    throw err;
  }
}

const VAULT_TABS = ["heirs", "guardians", "assets", "parameters", "activity", "watchdog", "message"] as const;
type VaultTab = (typeof VAULT_TABS)[number];

export default function VaultDashboardPage() {
  const mounted = useMounted();
  const { address, isConnected, isConnecting, isReconnecting } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const isWrongChain = isConnected && chainId !== worldChainSepolia.id;
  const { openConnectModal } = useWalletModal();
  const publicClient = usePublicClient();

  // No persisted "last vault" — landing on /vault always shows the dashboard
  // hub first; a specific vault is only opened by an explicit user action.
  const [selectedVaultState, setSelectedVaultState] = useState<`0x${string}` | null>(null);
  const [optimisticLiveness, setOptimisticLiveness] = useState<{ vault: `0x${string}`; value: boolean } | null>(null);
  const [isCheckInModalOpen, setIsCheckInModalOpen] = useState(false);
  const [isSettling, setIsSettling] = useState(false);
  const [orchestratedMessage, setOrchestratedMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<VaultTab>("heirs");
  const [assetList, setAssetList] = useState<AssetRecord[]>([]);
  const sessionLabelsRef = useRef<Map<string, string>>(new Map());
  const [isHealthLoading, setIsHealthLoading] = useState(false);
  const isHealthFetchingRef = useRef(false);

  // Deployment state
  const [isCreatingVault, setIsCreatingVault] = useState(false);
  const [deployStage, setDeployStage] = useState<DeploymentStage>("idle");
  const [deployTxHash, setDeployTxHash] = useState<string | null>(null);
  const [deployedVaultAddr, setDeployedVaultAddr] = useState<string | null>(null);
  const [deployErrorMessage, setDeployErrorMessage] = useState<string | null>(null);

  // Web2 naming flow: the "name your vault" step precedes deployment, and the
  // chosen name is persisted off-chain once the vault address is known.
  const [isNamingVault, setIsNamingVault] = useState(false);
  const [pendingNames, setPendingNames] = useState<{ vaultName: string; ownerName: string } | null>(null);
  // Name the owner used on any earlier vault — pre-fills "Your name" next time.
  const [knownOwnerName, setKnownOwnerName] = useState<string>("");
  const [vaultMeta, setVaultMeta] = useState<VaultMetaRecord | null>(null);

  // The open vault lives in the URL (?v=0x…) so refresh/back/share keep it.
  const syncVaultToUrl = (vaultAddr: `0x${string}` | null) => {
    const url = new URL(window.location.href);
    if (vaultAddr) url.searchParams.set("v", vaultAddr);
    else {
      url.searchParams.delete("v");
      url.searchParams.delete("tab");
    }
    window.history.replaceState(null, "", url);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get("v");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring the open vault from the URL on mount
    if (v && isAddress(v)) setSelectedVaultState(getAddress(v));
    const tab = params.get("tab");
    if (tab && (VAULT_TABS as readonly string[]).includes(tab)) setActiveTab(tab as VaultTab);
  }, []);

  // Tabs are deep-linkable (?tab=assets) so refresh/share lands on the same section.
  const selectTab = (tab: VaultTab) => {
    setActiveTab(tab);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tab);
      window.history.replaceState(null, "", url);
    } catch {}
  };

  // WAI-ARIA tabs: arrow keys move between tabs, Home/End jump to the ends.
  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = VAULT_TABS.length - 1;
    let next = index;
    if (e.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (e.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else return;
    e.preventDefault();
    selectTab(VAULT_TABS[next]);
    document.getElementById(`tab-${VAULT_TABS[next]}`)?.focus();
  };

  const handleSelectVault = (vaultAddr: `0x${string}`) => {
    setSelectedVaultState(vaultAddr);
    syncVaultToUrl(vaultAddr);
  };

  const handleBackToDashboard = () => {
    setSelectedVaultState(null);
    syncVaultToUrl(null);
  };

  // ── Contract reads ───────────────────────────────────────────────
  const { data: userVaults, isLoading: isVaultsLoading, refetch: refetchVaults } = useReadContract({
    address: CONTRACT_ADDRESSES.factory,
    abi: LegacyVaultFactoryABI,
    functionName: "getVaults",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  // Case-insensitive: getVaults returns checksummed addresses, while addresses
  // from logs/URLs may be lowercase.
  const selectedVault =
    (selectedVaultState && userVaults?.find((v) => isAddressEqual(v, selectedVaultState))) || null;

  const { data: rawStatus, isLoading: isStatusLoading, refetch: refetchStatus } = useReadContract({
    address: selectedVault ?? undefined,
    abi: LegacyVaultABI,
    functionName: "getStatus",
    query: { enabled: Boolean(selectedVault), refetchInterval: 3000 },
  });

  const { data: lastCheckInRaw, refetch: refetchLastCheckIn } = useReadContract({
    address: selectedVault ?? undefined,
    abi: LegacyVaultABI,
    functionName: "lastCheckIn",
    query: { enabled: Boolean(selectedVault), refetchInterval: 3000 },
  });

  const { data: checkInIntervalRaw, refetch: refetchInterval } = useReadContract({
    address: selectedVault ?? undefined,
    abi: LegacyVaultABI,
    functionName: "checkInInterval",
    query: { enabled: Boolean(selectedVault) },
  });

  const { data: gracePeriodRaw, refetch: refetchGrace } = useReadContract({
    address: selectedVault ?? undefined,
    abi: LegacyVaultABI,
    functionName: "gracePeriod",
    query: { enabled: Boolean(selectedVault) },
  });

  const { data: contestableWindowRaw, refetch: refetchContestable } = useReadContract({
    address: selectedVault ?? undefined,
    abi: LegacyVaultABI,
    functionName: "contestableWindow",
    query: { enabled: Boolean(selectedVault) },
  });

  const { data: livenessRegisteredRaw, refetch: refetchLiveness } = useReadContract({
    address: selectedVault ?? undefined,
    abi: LegacyVaultABI,
    functionName: "livenessRegistered",
    query: { enabled: Boolean(selectedVault) },
  });

  const { data: rawHeirs, refetch: refetchHeirs } = useReadContract({
    address: selectedVault ?? undefined,
    abi: LegacyVaultABI,
    functionName: "getHeirs",
    query: { enabled: Boolean(selectedVault) },
  });

  const { data: rawGuardians, refetch: refetchGuardians } = useReadContract({
    address: selectedVault ?? undefined,
    abi: LegacyVaultABI,
    functionName: "getGuardians",
    query: { enabled: Boolean(selectedVault), refetchInterval: 3000 },
  });

  const { data: deathAttestationCountRaw, refetch: refetchAttestations } = useReadContract({
    address: selectedVault ?? undefined,
    abi: LegacyVaultABI,
    functionName: "deathAttestationCount",
    query: { enabled: Boolean(selectedVault), refetchInterval: 3000 },
  });

  const { data: deathConfirmedRaw, refetch: refetchDeathConfirmed } = useReadContract({
    address: selectedVault ?? undefined,
    abi: LegacyVaultABI,
    functionName: "deathConfirmed",
    query: { enabled: Boolean(selectedVault), refetchInterval: 3000 },
  });

  const { data: vaultOwner } = useReadContract({
    address: selectedVault ?? undefined,
    abi: LegacyVaultABI,
    functionName: "owner",
    query: { enabled: Boolean(selectedVault) },
  });

  const { data: vaultVerifier, refetch: refetchVerifier } = useReadContract({
    address: selectedVault ?? undefined,
    abi: LegacyVaultABI,
    functionName: "verifier",
    query: { enabled: Boolean(selectedVault) },
  });

  const { writeContractAsync } = useWriteContract();

  // ── Derived state ─────────────────────────────────────────────────
  const status = rawStatus !== undefined ? (Number(rawStatus) as VaultStatus) : VaultStatus.Green;
  const lastCheckIn = lastCheckInRaw !== undefined ? BigInt(lastCheckInRaw.toString()) : BigInt(0);
  const checkInInterval = checkInIntervalRaw !== undefined ? BigInt(checkInIntervalRaw.toString()) : BigInt(86400 * 30);
  const gracePeriod = gracePeriodRaw !== undefined ? BigInt(gracePeriodRaw.toString()) : BigInt(86400 * 7);
  const contestableWindow = contestableWindowRaw !== undefined ? BigInt(contestableWindowRaw.toString()) : BigInt(3600 * 48);
  const livenessRegistered =
    optimisticLiveness && selectedVault && optimisticLiveness.vault.toLowerCase() === selectedVault.toLowerCase()
      ? optimisticLiveness.value
      : Boolean(livenessRegisteredRaw);
  const heirs = (rawHeirs as readonly `0x${string}`[]) || [];
  const heirNames = heirNameMap(vaultMeta);
  const vaultName = vaultMeta?.vaultName;
  const ownerName = vaultMeta?.ownerName;
  const guardians = (rawGuardians as readonly `0x${string}`[]) || [];
  const deathAttestationCount = deathAttestationCountRaw !== undefined ? Number(deathAttestationCountRaw) : 0;
  const deathConfirmed = Boolean(deathConfirmedRaw);

  // Load off-chain metadata (vault name + beneficiary names) whenever the
  // selected vault changes. Names are best-effort; a failure just falls back
  // to addresses.
  const loadVaultMeta = useCallback(async (vault: `0x${string}`) => {
    const meta = await fetchVaultMeta(vault);
    setVaultMeta(meta);
  }, []);

  useEffect(() => {
    if (!selectedVault) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing stale meta on deselect
      setVaultMeta(null);
      return;
    }
    loadVaultMeta(selectedVault);
  }, [selectedVault, loadVaultMeta]);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    fetchVaultMetasByOwner(address).then((metas) => {
      const known = metas.find((m) => m.ownerName)?.ownerName;
      if (!cancelled && known) setKnownOwnerName(known);
    });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const handleSaveNames = async (names: { vaultName: string; ownerName: string }) => {
    if (!selectedVault || !address) return false;
    const ok = await saveVaultNames(selectedVault, address, names);
    if (ok) {
      setKnownOwnerName(names.ownerName);
      await loadVaultMeta(selectedVault);
    }
    return ok;
  };

  const refreshAssetsAndHealth = useCallback(async () => {
    if (!publicClient || !selectedVault) {
      setAssetList([]);
      return;
    }
    if (isHealthFetchingRef.current) return;
    isHealthFetchingRef.current = true;
    setIsHealthLoading(true);

    try {
      const rawAllocations = await loadVaultAllocations(publicClient, selectedVault);
      const ownerAddress = (vaultOwner as `0x${string}`) || address;
      if (!ownerAddress) {
        const fallbackRecords: AssetRecord[] = rawAllocations.map((a) => {
          const sessionLabel = sessionLabelsRef.current.get(a.assetId.toLowerCase());
          return {
            assetId: a.assetId,
            label: sessionLabel || `${shortAddress(a.executor)}`,
            assetType: "UNKNOWN",
            heir: a.heir,
            executor: a.executor,
            executed: a.executed,
          };
        });
        setAssetList(fallbackRecords);
        return;
      }

      const healthResults = await assessAllocations(
        publicClient,
        selectedVault,
        ownerAddress,
        rawAllocations
      );

      const records: AssetRecord[] = healthResults.map((h) => {
        const sessionLabel = sessionLabelsRef.current.get(h.assetId.toLowerCase());
        const label = sessionLabel || h.label || shortAddress(h.executor);
        return {
          assetId: h.assetId,
          label,
          assetType: h.kind === "ERC20" || h.kind === "ERC721" || h.kind === "ENS" ? h.kind : "UNKNOWN",
          heir: h.heir,
          executor: h.executor,
          executed: h.executed,
          health: h,
        };
      });

      setAssetList(records);
    } catch (err) {
      console.warn("[Vault] Failed to refresh assets and health:", err);
    } finally {
      isHealthFetchingRef.current = false;
      setIsHealthLoading(false);
    }
  }, [publicClient, selectedVault, vaultOwner, address]);

  const healthSummary = useMemo(() => {
    const healthItems = assetList
      .map((a) => a.health)
      .filter((h): h is AllocationHealth => Boolean(h));
    return summarizeHealth(healthItems);
  }, [assetList]);

  useEffect(() => {
    if (selectedVault) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch of on-chain logs, not a sync setState
      refreshAssetsAndHealth();
    } else {
      setAssetList([]);
    }
  }, [selectedVault, address, refreshAssetsAndHealth]);

  useEffect(() => {
    if (activeTab === "assets" && selectedVault) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch of on-chain logs, not a sync setState
      refreshAssetsAndHealth();
    }
  }, [activeTab, selectedVault, refreshAssetsAndHealth]);

  useEffect(() => {
    if (!selectedVault || activeTab !== "assets") return;

    const intervalId = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        refreshAssetsAndHealth();
      }
    }, 60000);

    return () => clearInterval(intervalId);
  }, [selectedVault, activeTab, refreshAssetsAndHealth]);

  const refetchAll = useCallback(() => {
    refetchStatus();
    refetchLastCheckIn();
    refetchInterval();
    refetchGrace();
    refetchContestable();
    refetchLiveness();
    refetchHeirs();
    refetchGuardians();
    refetchAttestations();
    refetchDeathConfirmed();
    refetchVerifier();
  }, [refetchStatus, refetchLastCheckIn, refetchInterval, refetchGrace, refetchContestable, refetchLiveness, refetchHeirs, refetchGuardians, refetchAttestations, refetchDeathConfirmed, refetchVerifier]);

  // ── Handlers ──────────────────────────────────────────────────────
  const handleCheckInSuccess = (message: string) => {
    setIsSettling(true);
    setOrchestratedMessage(message);
    refetchAll();
    setTimeout(() => setIsSettling(false), 700);
    setTimeout(() => setOrchestratedMessage(null), 9000);
  };

  const handlePerformCheckInTx = async (
    root: bigint,
    nullifierHash: bigint,
    proof: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
  ) => {
    if (!publicClient || !selectedVault) throw new Error("Client or vault unavailable");
    try {
      console.log("👉 [Vault] Calling checkIn on contract:", {
        vault: selectedVault,
        root: root.toString(),
        nullifierHash: nullifierHash.toString(),
        proofLength: proof.length,
      });
      await assertLivenessCallSucceeds(
        () =>
          publicClient.simulateContract({
            account: address,
            address: selectedVault,
            abi: LivenessCallABI,
            functionName: "checkIn",
            args: [root, nullifierHash, proof],
          }),
        "checkIn"
      );
      const hash = await writeContractAsync({
        chainId: worldChainSepolia.id,
        address: selectedVault,
        abi: LegacyVaultABI,
        functionName: "checkIn",
        args: [root, nullifierHash, proof],
        gas: 450000n,
      });
      console.log("⏳ [Vault] checkIn tx broadcast:", hash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") {
        console.error("❌ [Vault] checkIn transaction reverted on-chain:", receipt);
        throw new Error(`Check-in transaction reverted on-chain (tx ${hash}).`);
      }
      console.log("✅ [Vault] checkIn confirmed on-chain");
    } catch (err: unknown) {
      console.error("❌ [Vault] checkIn failed:", err);
      throw err;
    }
  };

  const handleRegisterLivenessTx = async (
    root: bigint,
    nullifierHash: bigint,
    proof: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
  ) => {
    if (!publicClient || !selectedVault) throw new Error("Client or vault unavailable");
    try {
      console.log("👉 [Vault] Calling registerLiveness on contract:", {
        vault: selectedVault,
        root: root.toString(),
        nullifierHash: nullifierHash.toString(),
        proofLength: proof.length,
      });
      await assertLivenessCallSucceeds(
        () =>
          publicClient.simulateContract({
            account: address,
            address: selectedVault,
            abi: LivenessCallABI,
            functionName: "registerLiveness",
            args: [root, nullifierHash, proof],
          }),
        "registerLiveness"
      );
      const hash = await writeContractAsync({
        chainId: worldChainSepolia.id,
        address: selectedVault,
        abi: LegacyVaultABI,
        functionName: "registerLiveness",
        args: [root, nullifierHash, proof],
        gas: 450000n,
      });
      console.log("⏳ [Vault] registerLiveness tx broadcast:", hash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") {
        console.error("❌ [Vault] registerLiveness transaction reverted on-chain:", receipt);
        throw new Error(`Liveness registration reverted on-chain (tx ${hash}).`);
      }
      if (selectedVault) {
        setOptimisticLiveness({ vault: selectedVault, value: true });
      }

      // If vault is not Green (e.g. interval expired before initial enrollment), immediately check in to restore Green
      try {
        const currentStatus = await publicClient.readContract({
          address: selectedVault,
          abi: LegacyVaultABI,
          functionName: "getStatus",
        });
        if (Number(currentStatus) !== 0) {
          console.log("👉 [Vault] Vault is currently not Green, automatically checking in to restore Green...");
          const checkInHash = await writeContractAsync({
            chainId: worldChainSepolia.id,
            address: selectedVault,
            abi: LegacyVaultABI,
            functionName: "checkIn",
            args: [root, nullifierHash, proof],
            gas: 450000n,
          });
          await publicClient.waitForTransactionReceipt({ hash: checkInHash });
          console.log("✅ [Vault] Auto check-in confirmed, vault restored to Green");
        }
      } catch (autoErr) {
        console.warn("⚠️ [Vault] Auto check-in follow-up warning:", autoErr);
      }

      refetchAll();
    } catch (err: unknown) {
      console.error("❌ [Vault] registerLiveness failed:", err);
      throw err;
    }
  };

  const handleAddHeir = async (heir: `0x${string}`, name: string) => {
    if (!publicClient || !selectedVault) throw new Error("Client or vault unavailable");
    try {
      console.log("👉 [Vault] Calling addHeir:", { vault: selectedVault, heir, name });
      // Pre-flight check: ensure vault is Green before attempting transaction
      const currentStatus = await publicClient.readContract({
        address: selectedVault,
        abi: LegacyVaultABI,
        functionName: "getStatus",
      });
      if (Number(currentStatus) !== 0) {
        throw new Error(
          `Cannot add heir: Vault is currently in ${
            Number(currentStatus) === 1 ? "Amber" : "Red"
          } status. Heir modifications are locked while vault is not in Green status. Please perform a World ID check-in above to restore Green status first.`
        );
      }

      const hash = await writeContractAsync({
        chainId: worldChainSepolia.id,
        address: selectedVault,
        abi: LegacyVaultABI,
        functionName: "addHeir",
        args: [heir],
        gas: 250000n,
      });
      console.log("⏳ [Vault] addHeir tx broadcast:", hash);
      await publicClient.waitForTransactionReceipt({ hash });
      console.log("✅ [Vault] addHeir confirmed on-chain");
      refetchHeirs();
      // Persist the beneficiary's friendly name off-chain (best-effort).
      if (address && name.trim()) {
        await saveHeirName(selectedVault, address, heir, name.trim());
        await loadVaultMeta(selectedVault);
      }
    } catch (err: unknown) {
      console.error("❌ [Vault] addHeir error details:", err);
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("HeirChangesLocked") ||
        msg.includes("6eefa6e8") ||
        msg.toLowerCase().includes("gas limit") ||
        msg.includes("0x12c1")
      ) {
        throw new Error("Cannot add heir: Vault is not Green. Heir modifications are locked while vault is Amber or Red. Perform a World ID check-in above to restore Green status first.");
      }
      throw err;
    }
  };

  const handleRemoveHeir = async (heir: `0x${string}`) => {
    if (!publicClient || !selectedVault) throw new Error("Client or vault unavailable");
    try {
      console.log("👉 [Vault] Calling removeHeir:", { vault: selectedVault, heir });
      const currentStatus = await publicClient.readContract({
        address: selectedVault,
        abi: LegacyVaultABI,
        functionName: "getStatus",
      });
      if (Number(currentStatus) !== 0) {
        throw new Error(
          `Cannot remove heir: Vault is currently in ${
            Number(currentStatus) === 1 ? "Amber" : "Red"
          } status. Heir modifications are locked while vault is not in Green status. Please perform a World ID check-in above to restore Green status first.`
        );
      }

      const hash = await writeContractAsync({
        chainId: worldChainSepolia.id,
        address: selectedVault,
        abi: LegacyVaultABI,
        functionName: "removeHeir",
        args: [heir],
        gas: 200000n,
      });
      console.log("⏳ [Vault] removeHeir tx broadcast:", hash);
      await publicClient.waitForTransactionReceipt({ hash });
      console.log("✅ [Vault] removeHeir confirmed on-chain");
      refetchHeirs();
      // Drop the stored name too, so a re-added address doesn't inherit a stale label.
      await removeHeirNameMeta(selectedVault, heir);
      await loadVaultMeta(selectedVault);
    } catch (err: unknown) {
      console.error("❌ [Vault] removeHeir error details:", err);
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("HeirChangesLocked") ||
        msg.includes("6eefa6e8") ||
        msg.toLowerCase().includes("gas limit") ||
        msg.includes("0x12c1")
      ) {
        throw new Error("Cannot remove heir: Vault is not Green. Heir modifications are locked while vault is Amber or Red. Perform a World ID check-in above to restore Green status first.");
      }
      throw err;
    }
  };

  const handleAddGuardian = async (guardian: `0x${string}`) => {
    if (!publicClient || !selectedVault) throw new Error("Client or vault unavailable");
    try {
      const currentStatus = await publicClient.readContract({
        address: selectedVault,
        abi: LegacyVaultABI,
        functionName: "getStatus",
      });
      if (Number(currentStatus) !== 0) {
        throw new Error(
          `Cannot add guardian: Vault is currently in ${
            Number(currentStatus) === 1 ? "Amber" : "Red"
          } status. Guardian changes are locked while the vault is not Green. Perform a World ID check-in to restore Green status first.`
        );
      }
      const hash = await writeContractAsync({
        chainId: worldChainSepolia.id,
        address: selectedVault,
        abi: LegacyVaultABI,
        functionName: "addGuardian",
        args: [guardian],
        gas: 250000n,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      refetchGuardians();
      refetchAttestations();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("HeirChangesLocked") || msg.toLowerCase().includes("gas limit") || msg.includes("0x12c1")) {
        throw new Error("Cannot add guardian: Vault is not Green. Guardian changes are locked while the vault is Amber or Red.");
      }
      if (msg.includes("InvalidGuardian")) throw new Error("Invalid guardian: cannot be the zero address or the owner.");
      if (msg.includes("GuardianAlreadyRegistered")) throw new Error("That address is already a guardian.");
      throw err;
    }
  };

  const handleRemoveGuardian = async (guardian: `0x${string}`) => {
    if (!publicClient || !selectedVault) throw new Error("Client or vault unavailable");
    try {
      const currentStatus = await publicClient.readContract({
        address: selectedVault,
        abi: LegacyVaultABI,
        functionName: "getStatus",
      });
      if (Number(currentStatus) !== 0) {
        throw new Error(
          `Cannot remove guardian: Vault is currently in ${
            Number(currentStatus) === 1 ? "Amber" : "Red"
          } status. Guardian changes are locked while the vault is not Green.`
        );
      }
      const hash = await writeContractAsync({
        chainId: worldChainSepolia.id,
        address: selectedVault,
        abi: LegacyVaultABI,
        functionName: "removeGuardian",
        args: [guardian],
        gas: 200000n,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      refetchGuardians();
      refetchAttestations();
      refetchDeathConfirmed();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("HeirChangesLocked") || msg.toLowerCase().includes("gas limit") || msg.includes("0x12c1")) {
        throw new Error("Cannot remove guardian: Vault is not Green. Guardian changes are locked while the vault is Amber or Red.");
      }
      throw err;
    }
  };

  const handleAssignAsset = async (
    assetId: `0x${string}`,
    heir: `0x${string}`,
    executor: `0x${string}`,
    label: string
  ) => {
    if (!publicClient || !selectedVault) throw new Error("Client or vault unavailable");
    try {
      console.log("👉 [Vault] Calling assignAsset:", { vault: selectedVault, assetId, heir, executor, label });
      const currentStatus = await publicClient.readContract({
        address: selectedVault,
        abi: LegacyVaultABI,
        functionName: "getStatus",
      });
      if (Number(currentStatus) !== 0) {
        throw new Error(
          `Cannot assign asset: Vault is currently in ${
            Number(currentStatus) === 1 ? "Amber" : "Red"
          } status. Asset assignments are locked while vault is not in Green status. Please perform a World ID check-in above to restore Green status first.`
        );
      }

      const hash = await writeContractAsync({
        chainId: worldChainSepolia.id,
        address: selectedVault,
        abi: LegacyVaultABI,
        functionName: "assignAsset",
        args: [assetId, heir, executor],
        gas: 300000n,
      });
      console.log("⏳ [Vault] assignAsset tx broadcast:", hash);
      await publicClient.waitForTransactionReceipt({ hash });
      console.log("✅ [Vault] assignAsset confirmed on-chain");
      sessionLabelsRef.current.set(assetId.toLowerCase(), label);
      setAssetList((prev) => {
        const filtered = prev.filter((a) => a.assetId.toLowerCase() !== assetId.toLowerCase());
        return [...filtered, { assetId, label, assetType: "ERC20", heir, executor, executed: false }];
      });
      refreshAssetsAndHealth();
    } catch (err: unknown) {
      console.error("❌ [Vault] assignAsset error details:", err);
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("HeirChangesLocked") ||
        msg.includes("6eefa6e8") ||
        msg.toLowerCase().includes("gas limit") ||
        msg.includes("0x12c1")
      ) {
        throw new Error("Cannot assign asset: Vault is not Green. Asset assignments are locked while vault is Amber or Red. Perform a World ID check-in above to restore Green status first.");
      }
      throw err;
    }
  };

  const handleRemoveAsset = async (assetId: `0x${string}`) => {
    if (!publicClient || !selectedVault) throw new Error("Client or vault unavailable");
    try {
      console.log("👉 [Vault] Calling removeAsset:", { vault: selectedVault, assetId });
      const currentStatus = await publicClient.readContract({
        address: selectedVault,
        abi: LegacyVaultABI,
        functionName: "getStatus",
      });
      if (Number(currentStatus) !== 0) {
        throw new Error(
          `Cannot remove asset: Vault is currently in ${
            Number(currentStatus) === 1 ? "Amber" : "Red"
          } status. Asset modifications are locked while vault is not in Green status. Please perform a World ID check-in above to restore Green status first.`
        );
      }

      const hash = await writeContractAsync({
        chainId: worldChainSepolia.id,
        address: selectedVault,
        abi: LegacyVaultABI,
        functionName: "removeAsset",
        args: [assetId],
        gas: 200000n,
      });
      console.log("⏳ [Vault] removeAsset tx broadcast:", hash);
      await publicClient.waitForTransactionReceipt({ hash });
      console.log("✅ [Vault] removeAsset confirmed on-chain");
      sessionLabelsRef.current.delete(assetId.toLowerCase());
      setAssetList((prev) => prev.filter((a) => a.assetId.toLowerCase() !== assetId.toLowerCase()));
      refreshAssetsAndHealth();
    } catch (err: unknown) {
      console.error("❌ [Vault] removeAsset error details:", err);
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("HeirChangesLocked") ||
        msg.includes("6eefa6e8") ||
        msg.toLowerCase().includes("gas limit") ||
        msg.includes("0x12c1")
      ) {
        throw new Error("Cannot remove asset: Vault is not Green. Asset modifications are locked while vault is Amber or Red. Perform a World ID check-in above to restore Green status first.");
      }
      throw err;
    }
  };

  const handleUpdateParameters = async (
    newInterval: bigint,
    newGrace: bigint,
    newContestable: bigint
  ) => {
    if (!publicClient || !selectedVault) throw new Error("Client or vault unavailable");
    try {
      console.log("👉 [Vault] Calling updateParameters:", { vault: selectedVault, newInterval, newGrace, newContestable });
      const currentStatus = await publicClient.readContract({
        address: selectedVault,
        abi: LegacyVaultABI,
        functionName: "getStatus",
      });
      if (Number(currentStatus) !== 0) {
        throw new Error(
          `Cannot update parameters: Vault is currently in ${
            Number(currentStatus) === 1 ? "Amber" : "Red"
          } status. Parameters are locked while vault is not in Green status. Please perform a World ID check-in above to restore Green status first.`
        );
      }

      const hash = await writeContractAsync({
        chainId: worldChainSepolia.id,
        address: selectedVault,
        abi: LegacyVaultABI,
        functionName: "updateParameters",
        args: [newInterval, newGrace, newContestable],
        gas: 200000n,
      });
      console.log("⏳ [Vault] updateParameters tx broadcast:", hash);
      await publicClient.waitForTransactionReceipt({ hash });
      console.log("✅ [Vault] updateParameters confirmed on-chain");
      refetchInterval();
      refetchGrace();
      refetchContestable();
    } catch (err: unknown) {
      console.error("❌ [Vault] updateParameters error details:", err);
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("ParametersLockedWhileNotGreen") ||
        msg.includes("6eefa6e8") ||
        msg.toLowerCase().includes("gas limit") ||
        msg.includes("0x12c1")
      ) {
        throw new Error("Cannot update parameters: Vault is not Green. Parameters are locked while vault is Amber or Red. Perform a World ID check-in above to restore Green status first.");
      }
      throw err;
    }
  };

  // `names` is passed explicitly on first deploy: reading `pendingNames` state
  // right after setting it would see the previous render's value. Retries
  // (no argument) fall back to the state, which has settled by then.
  const handleCreateVault = async (names?: { vaultName: string; ownerName: string }) => {
    if (!publicClient) throw new Error("Public client unavailable");
    const namesToSave = names ?? pendingNames;
    try {
      setIsCreatingVault(true);
      setDeployErrorMessage(null);
      setDeployTxHash(null);
      setDeployedVaultAddr(null);
      setDeployStage("requesting_signature");

      if (isWrongChain && switchChain) {
        await switchChain({ chainId: worldChainSepolia.id });
      }
      console.log("👉 [Vault] Calling createVault on factory:", {
        factory: CONTRACT_ADDRESSES.factory,
        verifier: CONTRACT_ADDRESSES.verifier,
        checkInInterval: 45n,
        gracePeriod: 15n,
        contestableWindow: 45n,
      });
      const hash = await writeContractAsync({
        chainId: worldChainSepolia.id,
        address: CONTRACT_ADDRESSES.factory,
        abi: LegacyVaultFactoryABI,
        functionName: "createVault",
        args: [
          CONTRACT_ADDRESSES.verifier,
          45n, // 45s check-in interval
          15n, // 15s grace period
          45n, // 45s contestable window
        ],
      });
      setDeployTxHash(hash);
      setDeployStage("confirming");
      console.log("⏳ [Vault] createVault tx broadcast:", hash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log("✅ [Vault] createVault confirmed on-chain");
      setDeployStage("indexing");
      const vaultCreatedLog = receipt.logs.find(
        (l) => l.topics[0]?.toLowerCase() === "0x5d9c31ffa0fecffd7cf379989a3c7af252f0335e0d2a1320b55245912c781f53"
      );
      let newVaultAddr: `0x${string}` | null = null;
      if (vaultCreatedLog?.topics[2]) {
        newVaultAddr = getAddress(`0x${vaultCreatedLog.topics[2].slice(26)}`);
      }
      setDeployStage("syncing");
      // The RPC gateway is load-balanced, so a read right after the receipt can
      // hit a node that hasn't seen this block yet. Poll until the new vault
      // appears in getVaults (~10s max) so the dashboard can open it.
      let { data: updatedVaults } = await refetchVaults();
      for (let attempt = 0; newVaultAddr && attempt < 10; attempt++) {
        const target = newVaultAddr;
        if (updatedVaults?.some((v) => isAddressEqual(v, target))) break;
        await new Promise((r) => setTimeout(r, 1000));
        ({ data: updatedVaults } = await refetchVaults());
      }
      let resolvedVault: `0x${string}` | null = null;
      if (newVaultAddr) {
        resolvedVault = newVaultAddr;
        setDeployedVaultAddr(newVaultAddr);
        handleSelectVault(newVaultAddr);
      } else if (updatedVaults && updatedVaults.length > 0) {
        const fallbackVault = updatedVaults[updatedVaults.length - 1];
        resolvedVault = fallbackVault;
        setDeployedVaultAddr(fallbackVault);
        handleSelectVault(fallbackVault);
      }
      // Persist the vault + owner names off-chain (best-effort).
      if (resolvedVault && address && namesToSave) {
        await saveVaultNames(resolvedVault, address, namesToSave);
        setKnownOwnerName(namesToSave.ownerName);
        await loadVaultMeta(resolvedVault);
      }
      refetchAll();
      setDeployStage("success");
      setTimeout(() => {
        setIsCreatingVault(false);
        setDeployStage("idle");
      }, 1800);
    } catch (err: unknown) {
      console.error("❌ [Vault] createVault error details:", err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("rejected") || msg.includes("4001") || msg.includes("User denied") || msg.includes("denied")) {
        setDeployErrorMessage("You declined the request in your wallet.");
      } else {
        setDeployErrorMessage(err instanceof BaseError ? err.shortMessage : msg);
      }
      setDeployStage("error");
    }
  };

  // Web2 flow: open the naming step first; deployment starts only once the
  // owner has named the vault and confirmed.
  const openVaultCreation = () => {
    if (isWrongChain) {
      switchChain?.({ chainId: worldChainSepolia.id });
      return;
    }
    setDeployErrorMessage(null);
    setIsNamingVault(true);
  };

  const handleConfirmVaultName = (vaultName: string, ownerName: string) => {
    const names = { vaultName, ownerName };
    setPendingNames(names);
    setIsNamingVault(false);
    handleCreateVault(names);
  };

  // ── Safe SSR & Mounting State ─────────────────────────────────────
  if (!mounted || isConnecting || isReconnecting) {
    return <VaultDashboardSkeleton message="CONNECTING WALLET" />;
  }

  // ── Not Connected State ───────────────────────────────────────────
  if (!isConnected) {
    return (
      <div className="landing-canvas" style={{ minHeight: "calc(100vh - var(--header-height, 64px))", padding: "40px 24px 96px" }}>
        <div className="app-container">
          {/* Navigation Breadcrumb Bar */}
          <div style={{ marginBottom: "24px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.8125rem" }}>
              <Link
                href="/"
                style={{ color: "var(--text-secondary)", textDecoration: "none" }}
              >
                Home
              </Link>
              <span style={{ color: "rgba(255, 255, 255, 0.25)" }}>/</span>
              <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>Vault Console</span>
            </div>
          </div>

          {/* Primary Instrument Box */}
          <div className="panel-instrument" style={{ background: "#000000", border: "1px solid rgba(255, 255, 255, 0.15)" }}>
            <div style={{ padding: "36px 32px 28px", borderBottom: "1px solid rgba(255, 255, 255, 0.1)" }}>
              <h1
                className="section-title"
                style={{
                  fontFamily: "'Murs Gothic', var(--font-murs-gothic), sans-serif",
                  fontSize: "clamp(1.8rem, 3.5vw, 2.6rem)",
                  marginBottom: "12px",
                }}
              >
                SUCCESSION VAULT INSTRUMENT
              </h1>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.9375rem", lineHeight: 1.6, maxWidth: 640 }}>
                Connect your wallet to configure your non-custodial succession vault, conduct World ID Orb liveness check-ins, designate beneficiaries, and adjust timelock parameters.
              </p>
            </div>

            <div style={{ padding: "36px 32px", display: "flex", flexDirection: "column", gap: "24px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px" }}>
                {[
                  { tag: "01", label: "Autonomous Heartbeat", desc: "World ID Orb-verified zero-knowledge liveness check-ins." },
                  { tag: "02", label: "Self-Sovereign Vault", desc: "Independent smart contract vault owned exclusively by you." },
                  { tag: "03", label: "Beneficiary Control", desc: "Granular heir designation & asset allocation percentages." },
                  { tag: "04", label: "Challenge Window", desc: "48-hour dispute-resistant contestable challenge window." },
                ].map((feature, i) => (
                  <div key={i} style={{ padding: "16px", background: "rgba(255, 255, 255, 0.02)", border: "1px solid rgba(255, 255, 255, 0.08)" }}>
                    <span style={{ color: "var(--accent-brass)", fontSize: "0.75rem", fontWeight: "bold", fontFamily: "var(--font-data)" }}>{feature.tag}</span>
                    <div style={{ fontWeight: 600, fontSize: "0.9375rem", color: "#EDEAE3", margin: "6px 0 4px" }}>{feature.label}</div>
                    <div style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>{feature.desc}</div>
                  </div>
                ))}
              </div>

              <div style={{ paddingTop: "12px", borderTop: "1px solid rgba(255, 255, 255, 0.08)", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "16px" }}>
                <div style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
                  Connect an Ethereum / World Chain compatible wallet to access your vault.
                </div>
                <button
                  type="button"
                  onClick={openConnectModal}
                  className="btn-hero-action"
                  style={{ marginTop: 0, padding: "12px 28px" }}
                >
                  <span>CONNECT WALLET</span>
                  <span className="arrow-icon" aria-hidden="true">→</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Loading state while reading factory vaults ─────────────────────
  if (isVaultsLoading || (userVaults === undefined && address)) {
    return <VaultDashboardSkeleton message="LOADING YOUR VAULTS" />;
  }

  // ── Connected State ───────────────────────────────────────────────
  return (
    <div className="landing-canvas vault-console" style={{ minHeight: "calc(100vh - var(--header-height, 64px))", padding: "32px 24px 96px" }}>
      <div style={{ maxWidth: "1600px", margin: "0 auto", width: "100%" }}>
        {isWrongChain && (
          <div
            style={{
              marginBottom: "20px",
              padding: "16px 20px",
              backgroundColor: "rgba(193, 80, 63, 0.15)",
              border: "1px solid var(--status-red)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ color: "var(--status-red)", fontWeight: 800, fontSize: "0.8125rem", letterSpacing: "0.04em" }}>
                [ WRONG NETWORK ]
              </span>
              <span style={{ color: "#EDEAE3", fontSize: "0.875rem" }}>
                Your wallet is currently connected to Chain ID {chainId}. Please switch to World Chain Sepolia (Chain ID {worldChainSepolia.id}) to deploy and manage vaults.
              </span>
            </div>
            <button
              type="button"
              onClick={() => switchChain?.({ chainId: worldChainSepolia.id })}
              className="btn-brass"
              style={{ padding: "8px 18px", fontSize: "0.75rem", whiteSpace: "nowrap" }}
            >
              SWITCH TO WORLD CHAIN SEPOLIA
            </button>
          </div>
        )}

        {/* ── Dashboard Hub (default) or 3-Column Vault Console ──────── */}
        {!selectedVault ? (
          <div className="panel-instrument" style={{ background: "#000000", border: "1px solid rgba(255, 255, 255, 0.15)" }}>
            <VaultDashboardHub
              ownedVaults={userVaults || []}
              isLoadingOwned={isVaultsLoading}
              onManageVault={handleSelectVault}
              onCreateVault={openVaultCreation}
              isCreatingVault={isCreatingVault}
              isWrongChain={Boolean(isWrongChain)}
              onSwitchChain={() => switchChain?.({ chainId: worldChainSepolia.id })}
            />
          </div>
        ) : (
        <div className="vault-console-layout">
                {/* Identity: vault name + owner lead; the contract address is secondary */}
                <VaultIdentityBar
                  vaultAddress={selectedVault}
                  vaultName={vaultName}
                  ownerName={ownerName}
                  onBack={handleBackToDashboard}
                  onSaveNames={handleSaveNames}
                />

                {orchestratedMessage && (
                  <div className="console-alert console-alert--success animate-banner-enter" role="status">
                    <p className="console-alert-body">{orchestratedMessage}</p>
                    <button
                      type="button"
                      onClick={() => setOrchestratedMessage(null)}
                      aria-label="Dismiss"
                      className="flow-close console-alert-dismiss"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                )}

                {deathConfirmed && (
                  <div className="console-alert console-alert--danger" role="alert">
                    <div className="console-alert-body">
                      <strong>Your guardians reported your death</strong>
                      <p>
                        {guardians.length === 1 ? "Your guardian" : `All ${guardians.length} guardians`} confirmed it, so heirs can
                        inherit almost immediately. If you&apos;re alive, check in to undo this.
                      </p>
                    </div>
                    <button type="button" onClick={() => setIsCheckInModalOpen(true)} className="flow-btn">
                      Check in
                    </button>
                  </div>
                )}

                {vaultVerifier && (vaultVerifier as string).toLowerCase() !== CONTRACT_ADDRESSES.verifier.toLowerCase() && (
                  <div className="console-alert console-alert--warning">
                    <div className="console-alert-body">
                      <strong>This vault can&apos;t check in on testnet</strong>
                      <p>It uses the production World ID verifier. Create a new vault to test.</p>
                    </div>
                    <button
                      type="button"
                      onClick={openVaultCreation}
                      disabled={isCreatingVault}
                      className="flow-btn flow-btn--ghost"
                    >
                      {isCreatingVault ? "Creating…" : "Create new vault"}
                    </button>
                  </div>
                )}

                {isStatusLoading && rawStatus === undefined ? (
                  <div className="console-card" style={{ display: "flex", justifyContent: "center" }}>
                    <LivenessPanelSkeleton />
                  </div>
                ) : (
                  <LivenessPanel
                    status={status}
                    lastCheckIn={lastCheckIn}
                    checkInInterval={checkInInterval}
                    gracePeriod={gracePeriod}
                    contestableWindow={contestableWindow}
                    livenessRegistered={livenessRegistered}
                    isSettling={isSettling}
                    onOpenCheckIn={() => setIsCheckInModalOpen(true)}
                    onEditTiming={() => selectTab("parameters")}
                  />
                )}

                {/* Health summary card directly below LivenessPanel */}
                {assetList.length > 0 && healthSummary.total > 0 && (
                  <div
                    className={`console-alert ${
                      healthSummary.underfunded > 0
                        ? "console-alert--warning"
                        : healthSummary.unknown > 0
                        ? ""
                        : "console-alert--success"
                    }`}
                    style={{
                      marginTop: "16px",
                      borderRadius: 0,
                      ...(healthSummary.underfunded === 0 && healthSummary.unknown > 0
                        ? { background: "rgba(255, 255, 255, 0.04)", borderColor: "rgba(255, 255, 255, 0.15)" }
                        : {}),
                    }}
                  >
                    <div className="console-alert-body">
                      <strong>
                        {healthSummary.underfunded === 0 && healthSummary.unknown === 0
                          ? `All ${healthSummary.total} assets are funded`
                          : `${healthSummary.funded} of ${healthSummary.total} assets will pay out`}
                      </strong>
                      <p>
                        {healthSummary.underfunded > 0
                          ? `${healthSummary.underfunded} ${
                              healthSummary.underfunded === 1 ? "asset is" : "assets are"
                            } underfunded and will fail if succession happens now.`
                          : healthSummary.unknown > 0
                          ? `Could not verify ${healthSummary.unknown} ${
                              healthSummary.unknown === 1 ? "asset" : "assets"
                            } right now.`
                          : "Wallet balances and approvals cover every assigned inheritance asset."}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => selectTab("assets")}
                      className="flow-btn flow-btn--ghost"
                      style={{ borderRadius: 0, whiteSpace: "nowrap" }}
                    >
                      View assets →
                    </button>
                  </div>
                )}

                <div className="console-card console-tabs-card">
                {/* Main Focus Area: Underline Tabs */}
                <div role="tablist" aria-label="Vault management sections" className="console-tabs">
                  {[
                    { id: "heirs", label: `Heirs (${heirs.length})` },
                    { id: "guardians", label: `Guardians (${guardians.length})` },
                    { id: "assets", label: `Assets (${assetList.length})` },
                    { id: "parameters", label: `Timing` },
                    { id: "activity", label: `Activity` },
                    { id: "watchdog", label: `Alerts` },
                    { id: "message", label: `Sealed Message` },
                  ].map((tab, index) => {
                    const isActive = activeTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        id={`tab-${tab.id}`}
                        aria-selected={isActive}
                        aria-controls={`tabpanel-${tab.id}`}
                        tabIndex={isActive ? 0 : -1}
                        onKeyDown={(e) => handleTabKeyDown(e, index)}
                        onClick={() => selectTab(tab.id as VaultTab)}
                        className={`dashboard-tab${isActive ? " dashboard-tab--active" : ""}`}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>

                {/* Tab Content Panels (Full remaining width) */}
                <div
                  role="tabpanel"
                  id={`tabpanel-${activeTab}`}
                  aria-labelledby={`tab-${activeTab}`}
                  className="console-tabpanel"
                >
                  {activeTab === "heirs" && (
                    <HeirList
                      heirs={heirs}
                      vaultStatus={status}
                      heirNames={heirNames}
                      onAddHeir={handleAddHeir}
                      onRemoveHeir={handleRemoveHeir}
                      isLoading={isStatusLoading && rawStatus === undefined}
                    />
                  )}

                  {activeTab === "guardians" && (
                    <GuardianList
                      guardians={guardians}
                      vaultStatus={status}
                      deathConfirmed={deathConfirmed}
                      attestationCount={deathAttestationCount}
                      onAddGuardian={handleAddGuardian}
                      onRemoveGuardian={handleRemoveGuardian}
                      isLoading={isStatusLoading && rawStatus === undefined}
                    />
                  )}

                  {activeTab === "assets" && (
                    <AssetList
                      assets={assetList}
                      heirs={heirs}
                      vaultStatus={status}
                      onAssignAsset={handleAssignAsset}
                      onRemoveAsset={handleRemoveAsset}
                      vaultAddress={selectedVault}
                      isHealthLoading={isHealthLoading}
                      onRecheckHealth={refreshAssetsAndHealth}
                    />
                  )}

                  {activeTab === "parameters" && (
                    <VaultParameters
                      checkInInterval={checkInInterval}
                      gracePeriod={gracePeriod}
                      contestableWindow={contestableWindow}
                      vaultStatus={status}
                      onUpdateParameters={handleUpdateParameters}
                      isLoading={isStatusLoading && rawStatus === undefined}
                    />
                  )}

                  {activeTab === "activity" && (
                    <ActivityLog
                      vaultAddress={selectedVault}
                      lastCheckIn={lastCheckIn}
                      livenessRegistered={livenessRegistered}
                      vaultStatus={status}
                    />
                  )}

                  {activeTab === "watchdog" && selectedVault && (
                    <WatchdogAlertPanel
                      vaultAddress={selectedVault}
                      ownerAddress={address}
                    />
                  )}

                  {activeTab === "message" && selectedVault && address && (
                    <SealedMessagePanel
                      vaultAddress={selectedVault}
                      ownerAddress={address}
                      heirs={heirs}
                      heirNames={heirNames}
                      onGoToHeirs={() => selectTab("heirs")}
                    />
                  )}
                </div>
                </div>
        </div>
        )}
      </div>

      {/* World ID Check-In / Registration Modal */}
      {selectedVault && (
        <CheckInModal
          isOpen={isCheckInModalOpen}
          onClose={() => setIsCheckInModalOpen(false)}
          vaultAddress={selectedVault}
          ownerAddress={(vaultOwner as `0x${string}`) || address || "0x0"}
          livenessRegistered={livenessRegistered}
          verifierAddress={(vaultVerifier as `0x${string}`) || undefined}
          onPerformCheckInTx={handlePerformCheckInTx}
          onRegisterLivenessTx={handleRegisterLivenessTx}
          onCheckInSuccess={handleCheckInSuccess}
        />
      )}

      {/* Web2 "name your vault" step — precedes deployment */}
      <VaultCreationModal
        isOpen={isNamingVault}
        onClose={() => setIsNamingVault(false)}
        onDeploy={handleConfirmVaultName}
        defaultOwnerName={knownOwnerName}
      />

      {/* Vault Deployment HUD Modal */}
      <VaultDeploymentModal
        isOpen={isCreatingVault}
        stage={deployStage}
        txHash={deployTxHash}
        vaultAddress={deployedVaultAddr}
        errorMessage={deployErrorMessage}
        onRetry={() => handleCreateVault()}
        onClose={() => {
          setIsCreatingVault(false);
          setDeployStage("idle");
        }}
      />
    </div>
  );
}
