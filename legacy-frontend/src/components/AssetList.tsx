"use client";

import React, { useState, useMemo } from "react";
import { useDialogBehavior } from "@/hooks/useDialogBehavior";
import {
  useAccount,
  useBalance,
  usePublicClient,
  useWalletClient,
  useWriteContract,
  useReadContracts,
} from "wagmi";
import {
  formatUnits,
  parseUnits,
  isAddress,
  keccak256,
  stringToHex,
} from "viem";
import { VaultStatus, worldChainSepolia } from "@/lib/constants";
import { ERC20ABI, ERC20AdapterABI, ERC20AdapterBytecode } from "@/lib/contracts/adapters";
import { AddressChip } from "./AddressChip";
import { Skeleton } from "./Skeleton";
import { AllocationHealthBadge, AllocationReadinessBanner } from "./AllocationHealth";
import type { AllocationHealthMap, AllocationReadiness, VaultAllocation } from "@/lib/allocations";

export interface AssetRecord {
  assetId: `0x${string}`;
  label: string;
  assetType: "ERC20" | "ERC721" | "ENS" | "CUSTOM";
  heir: `0x${string}`;
  executor: `0x${string}`;
  executed: boolean;
  /** The on-chain allocation this row was loaded from, used for health checks. */
  allocation?: VaultAllocation;
}

interface AssetListProps {
  assets: AssetRecord[];
  heirs: readonly `0x${string}`[];
  vaultStatus: VaultStatus;
  onAssignAsset: (
    assetId: `0x${string}`,
    heir: `0x${string}`,
    executor: `0x${string}`,
    label: string
  ) => Promise<void>;
  onRemoveAsset: (assetId: `0x${string}`) => Promise<void>;
  vaultAddress?: `0x${string}`;
  /** Live "would this pay out today?" state per allocation. */
  health?: AllocationHealthMap;
  readiness?: AllocationReadiness;
  isCheckingHealth?: boolean;
  /** Re-grants the executor's approval for an allocation that lost it. */
  onRestoreApproval?: (assetId: `0x${string}`) => Promise<void>;
}

export interface TokenItem {
  address?: `0x${string}`; // undefined for Native ETH
  name: string;
  symbol: string;
  decimals: number;
  isNative?: boolean;
  balance?: bigint;
  formattedBalance?: string;
  isCustom?: boolean;
}

const DEFAULT_TOKENS: TokenItem[] = [
  {
    name: "Native Ether",
    symbol: "ETH",
    decimals: 18,
    isNative: true,
  },
  {
    address: "0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88",
    name: "USD Coin (Circle)",
    symbol: "USDC",
    decimals: 6,
  },
];

const STORAGE_KEY = "legacy_imported_tokens_4801";

export function AssetList({
  assets,
  heirs,
  vaultStatus,
  onAssignAsset,
  onRemoveAsset,
  vaultAddress,
  health,
  readiness,
  isCheckingHealth,
  onRestoreApproval,
}: AssetListProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { writeContractAsync } = useWriteContract();

  // Native ETH balance via wagmi
  const { data: ethBalance, isLoading: isEthLoading } = useBalance({
    address,
    chainId: worldChainSepolia.id,
  });

  // Modal display states
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [modalMode, setModalMode] = useState<"TOKENS" | "EXECUTOR">("TOKENS");
  const [isSelectingToken, setIsSelectingToken] = useState(false);

  // Initialize tokens from localStorage
  const [tokenList, setTokenList] = useState<TokenItem[]>(() => {
    if (typeof window === "undefined") return DEFAULT_TOKENS;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed: TokenItem[] = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const existing = new Set(DEFAULT_TOKENS.map((t) => t.address?.toLowerCase()).filter(Boolean));
          const custom = parsed.filter((p) => p.address && !existing.has(p.address.toLowerCase()));
          return [...DEFAULT_TOKENS, ...custom];
        }
      }
    } catch {
      // fallback
    }
    return DEFAULT_TOKENS;
  });

  // Start on the first token that can actually be assigned (native ETH can't be), so the dialog opens ready to use
  const [selectedTokenIndex, setSelectedTokenIndex] = useState<number>(() => {
    const firstAssignable = DEFAULT_TOKENS.findIndex((t) => !t.isNative);
    return firstAssignable === -1 ? 0 : firstAssignable;
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [tokenFilter, setTokenFilter] = useState<"ALL" | "IN_WALLET">("ALL");

  // Custom token import search state
  const [importedTokenCandidate, setImportedTokenCandidate] = useState<TokenItem | null>(null);
  const [isSearchingContract, setIsSearchingContract] = useState(false);
  const [searchContractError, setSearchContractError] = useState<string | null>(null);

  // Form inputs
  const [amount, setAmount] = useState("");
  const [selectedHeir, setSelectedHeir] = useState<string>("");

  // Advanced / Manual Executor state
  const [manualLabel, setManualLabel] = useState("");
  const [manualAssetType, setManualAssetType] = useState<"ERC20" | "ERC721" | "ENS">("ERC20");
  const [manualExecutorAddress, setManualExecutorAddress] = useState("");

  // Orchestration state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [executionStage, setExecutionStage] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  // Errors from table actions (remove, re-approve), shown beside the table:
  // `errorText` only renders inside the assignment dialog.
  const [tableError, setTableError] = useState<string | null>(null);
  const [restoringAssetId, setRestoringAssetId] = useState<`0x${string}` | null>(null);

  const isGreen = vaultStatus === VaultStatus.Green;

  // Safe formatting for Native ETH (completely prevents NaN)
  const formattedEth = useMemo(() => {
    if (ethBalance?.value !== undefined) {
      try {
        const val = formatUnits(ethBalance.value, ethBalance.decimals);
        const parsed = parseFloat(val);
        return isNaN(parsed) ? "0.0000" : parsed.toFixed(4);
      } catch {
        return "0.0000";
      }
    }
    if ((ethBalance as { formatted?: string } | undefined)?.formatted) {
      const parsed = parseFloat((ethBalance as { formatted?: string }).formatted!);
      return isNaN(parsed) ? "0.0000" : parsed.toFixed(4);
    }
    return "0.0000";
  }, [ethBalance]);

  // Multicall queries for all ERC-20 tokens
  const erc20Calls = useMemo(() => {
    if (!address) return [];
    return tokenList
      .filter((t) => !t.isNative && t.address)
      .map((t) => ({
        address: t.address!,
        abi: ERC20ABI,
        functionName: "balanceOf" as const,
        args: [address] as const,
        chainId: worldChainSepolia.id,
      }));
  }, [address, tokenList]);

  const { data: erc20Balances } = useReadContracts({
    contracts: erc20Calls,
    query: {
      enabled: Boolean(showAssignModal && address && erc20Calls.length > 0),
    },
  });

  // Derived tokens combining base items + multicall balances
  const displayTokens = useMemo(() => {
    let callIdx = 0;
    return tokenList.map((t) => {
      if (t.isNative) {
        return {
          ...t,
          balance: ethBalance?.value ?? 0n,
          formattedBalance: formattedEth,
        };
      }
      const callResult = erc20Balances?.[callIdx++];
      const raw =
        callResult?.status === "success" && typeof callResult.result === "bigint"
          ? callResult.result
          : 0n;
      const formatted = formatUnits(raw, t.decimals);
      const parsed = parseFloat(formatted);
      return {
        ...t,
        balance: raw,
        formattedBalance: isNaN(parsed)
          ? "0.00"
          : parsed.toFixed(t.decimals > 6 ? 4 : 2),
      };
    });
  }, [tokenList, ethBalance, formattedEth, erc20Balances]);

  // Inspect address typed into search bar
  const handleSearchChange = async (query: string) => {
    setSearchQuery(query);
    setSearchContractError(null);
    setImportedTokenCandidate(null);

    const trimmed = query.trim();
    if (isAddress(trimmed)) {
      const existing = tokenList.find(
        (t) => t.address?.toLowerCase() === trimmed.toLowerCase()
      );
      if (existing) return;

      if (!publicClient || !address) return;

      try {
        setIsSearchingContract(true);
        const validAddr = trimmed as `0x${string}`;

        const [nameRes, symbolRes, decimalsRes, balanceRes] = await Promise.all([
          publicClient
            .readContract({
              address: validAddr,
              abi: ERC20ABI,
              functionName: "name",
            })
            .catch(() => "Custom Token"),
          publicClient
            .readContract({
              address: validAddr,
              abi: ERC20ABI,
              functionName: "symbol",
            })
            .catch(() => "TOKEN"),
          publicClient
            .readContract({
              address: validAddr,
              abi: ERC20ABI,
              functionName: "decimals",
            })
            .catch(() => 18),
          publicClient
            .readContract({
              address: validAddr,
              abi: ERC20ABI,
              functionName: "balanceOf",
              args: [address],
            })
            .catch(() => 0n),
        ]);

        const dec = Number(decimalsRes);
        const formatted = formatUnits(balanceRes, dec);
        const parsed = parseFloat(formatted);

        setImportedTokenCandidate({
          address: validAddr,
          name: String(nameRes),
          symbol: String(symbolRes),
          decimals: dec,
          balance: balanceRes,
          formattedBalance: isNaN(parsed) ? "0.00" : parsed.toFixed(dec > 6 ? 4 : 2),
          isCustom: true,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Contract is not an ERC-20 token";
        setSearchContractError(msg);
      } finally {
        setIsSearchingContract(false);
      }
    }
  };

  // Import custom token candidate
  const handleImportToken = (tokenToImport: TokenItem) => {
    setTokenList((prev) => {
      const newList = [...prev, tokenToImport];
      try {
        const customTokens = newList.filter((t) => t.isCustom && t.address);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(customTokens));
      } catch (err) {
        console.warn("Storage save error:", err);
      }
      return newList;
    });

    setSelectedTokenIndex(tokenList.length);
    setImportedTokenCandidate(null);
    setSearchQuery("");
    setIsSelectingToken(false);
  };

  // Currently active selected token
  const selectedToken = displayTokens[selectedTokenIndex] || displayTokens[0];

  // Token mode needs an assignable token and a positive amount before the confirm button wakes up
  const isTokenFormIncomplete =
    modalMode === "TOKENS"
      ? Boolean(selectedToken?.isNative) || !(Number(amount) > 0)
      : !manualLabel.trim() || !isAddress(manualExecutorAddress.trim());

  // Filtered tokens for token picker
  const filteredTokens = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return displayTokens.filter((t) => {
      const matchesQuery =
        !q ||
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        (t.address && t.address.toLowerCase().includes(q));

      if (tokenFilter === "IN_WALLET") {
        const hasBal = t.balance && t.balance > 0n;
        return matchesQuery && hasBal;
      }
      return matchesQuery;
    });
  }, [displayTokens, searchQuery, tokenFilter]);

  // Quick percentage shortcuts
  const handleSetPercentage = (pct: number) => {
    if (!selectedToken) return;
    const balanceNum = parseFloat(selectedToken.formattedBalance || "0");
    if (balanceNum <= 0) {
      setAmount("0");
      return;
    }
    const val = (balanceNum * (pct / 100)).toFixed(selectedToken.decimals > 6 ? 4 : 2);
    setAmount(val);
  };

  // Calculate allocation percentage of available balance
  const allocationPercent = useMemo(() => {
    if (!selectedToken || !amount) return 0;
    const inputNum = parseFloat(amount);
    const balanceNum = parseFloat(selectedToken.formattedBalance || "0");
    if (isNaN(inputNum) || isNaN(balanceNum) || balanceNum <= 0) return 0;
    return Math.min(100, Math.max(0, (inputNum / balanceNum) * 100));
  }, [amount, selectedToken]);

  // Submission handler
  const handleAssignSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorText(null);

    if (!selectedHeir) {
      setErrorText("Please select an authorized designated heir");
      return;
    }

    // Branch 1: Advanced / Custom Executor
    if (modalMode === "EXECUTOR") {
      if (!manualLabel.trim() || !manualExecutorAddress.trim()) {
        setErrorText("Asset label and executor contract address are required");
        return;
      }
      if (!isAddress(manualExecutorAddress.trim())) {
        setErrorText("Invalid executor contract address");
        return;
      }

      try {
        setIsSubmitting(true);
        setExecutionStage("Registering custom executor on vault clone...");

        const assetId = keccak256(
          stringToHex(`${manualLabel}-${selectedHeir}-${manualExecutorAddress.trim()}`)
        );

        await onAssignAsset(
          assetId,
          selectedHeir as `0x${string}`,
          manualExecutorAddress.trim() as `0x${string}`,
          manualLabel.trim()
        );

        setShowAssignModal(false);
        resetForm();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to assign asset";
        setErrorText(msg);
      } finally {
        setIsSubmitting(false);
        setExecutionStage(null);
      }
      return;
    }

    // Branch 2: Native ETH
    if (selectedToken.isNative) {
      setErrorText(
        "World Chain Sepolia requires an ERC-20 token allowance for automated non-custodial succession. Please select testnet USDC or wrap your ETH into WETH."
      );
      return;
    }

    // Branch 3: ERC-20 Token
    const tokenAddr = selectedToken.address;
    const tokenSymbol = selectedToken.symbol;
    const tokenDecimals = selectedToken.decimals;
    const currentBalance = selectedToken.balance ?? 0n;

    if (!tokenAddr) {
      setErrorText("Token contract address unavailable");
      return;
    }

    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      setErrorText("Please enter a valid positive token allocation amount");
      return;
    }

    if (!vaultAddress) {
      setErrorText("Vault clone address unavailable. Ensure a vault is active.");
      return;
    }

    if (!walletClient || !publicClient || !address) {
      setErrorText("Connected wallet or public client unavailable");
      return;
    }

    try {
      setIsSubmitting(true);
      const parsedAmount = parseUnits(amount, tokenDecimals);

      if (parsedAmount > currentBalance) {
        setErrorText(
          `Allocation amount (${amount} ${tokenSymbol}) exceeds detected wallet balance. The vault owner must hold tokens for succession claims to be executable.`
        );
        setIsSubmitting(false);
        return;
      }

      // Step 1: Deploy ERC20Adapter
      setExecutionStage(`[1/3] Deploying Non-Custodial ERC20Adapter for ${amount} ${tokenSymbol}...`);
      console.log("👉 Deploying ERC20Adapter:", {
        token: tokenAddr,
        amount: parsedAmount.toString(),
        vault: vaultAddress,
      });

      const deployHash = await walletClient.deployContract({
        abi: ERC20AdapterABI,
        bytecode: ERC20AdapterBytecode,
        args: [tokenAddr, parsedAmount, vaultAddress],
        chain: worldChainSepolia,
        account: address,
      });

      console.log("⏳ ERC20Adapter deployment tx broadcast:", deployHash);
      setExecutionStage("[1/3] Awaiting adapter deployment confirmation on World Chain Sepolia...");

      const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
      const adapterAddress = deployReceipt.contractAddress;

      if (!adapterAddress) {
        throw new Error("Adapter deployment succeeded but contract address was not returned.");
      }
      console.log("✅ ERC20Adapter deployed at:", adapterAddress);

      // Step 2: Approve the newly deployed adapter
      setExecutionStage(`[2/3] Authorizing ${amount} ${tokenSymbol} allowance for executor...`);

      const currentAllowance = await publicClient.readContract({
        address: tokenAddr,
        abi: ERC20ABI,
        functionName: "allowance",
        args: [address, adapterAddress],
      });

      if (currentAllowance < parsedAmount) {
        console.log("👉 Prompting approval for adapter:", adapterAddress);
        const approveHash = await writeContractAsync({
          chainId: worldChainSepolia.id,
          address: tokenAddr,
          abi: ERC20ABI,
          functionName: "approve",
          args: [adapterAddress, parsedAmount],
        });
        console.log("⏳ Approval tx broadcast:", approveHash);
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
        console.log("✅ Token allowance confirmed");
      }

      // Step 3: Register asset on LegacyVault
      setExecutionStage("[3/3] Registering succession assignment on vault clone...");

      const assetLabel = `${amount} ${tokenSymbol}`;
      const assetId = keccak256(
        stringToHex(`${assetLabel}-${selectedHeir}-${adapterAddress}`)
      );

      await onAssignAsset(
        assetId,
        selectedHeir as `0x${string}`,
        adapterAddress,
        assetLabel
      );

      setShowAssignModal(false);
      resetForm();
    } catch (err: unknown) {
      console.error("❌ Error in automated asset assignment:", err);
      const msg = err instanceof Error ? err.message : "Failed to allocate token";
      setErrorText(msg);
    } finally {
      setIsSubmitting(false);
      setExecutionStage(null);
    }
  };

  const resetForm = () => {
    setAmount("");
    setManualLabel("");
    setManualExecutorAddress("");
    setIsSelectingToken(false);
    setErrorText(null);
  };

  const closeModal = () => {
    if (isSubmitting) return;
    setShowAssignModal(false);
    resetForm();
  };

  // Escape, scroll lock, focus trap and focus restore for the assignment dialog
  const assignDialogRef = useDialogBehavior<HTMLDivElement>(showAssignModal, closeModal);

  const handleRemove = async (assetId: `0x${string}`) => {
    try {
      setIsSubmitting(true);
      setTableError(null);
      await onRemoveAsset(assetId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to remove asset";
      setTableError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRestoreApproval = async (assetId: `0x${string}`) => {
    if (!onRestoreApproval) return;
    try {
      setRestoringAssetId(assetId);
      setTableError(null);
      await onRestoreApproval(assetId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to re-approve asset";
      setTableError(msg);
    } finally {
      setRestoringAssetId(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Header Row */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
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
            Assets
          </h3>
          <p
            style={{
              fontSize: "0.875rem",
              color: "var(--text-secondary)",
              marginTop: "4px",
              lineHeight: 1.5,
            }}
          >
            The tokens, NFTs and ENS names each heir will receive.
          </p>
        </div>
        {isGreen && heirs.length > 0 && assets.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setSelectedHeir(heirs[0]);
              setShowAssignModal(true);
            }}
            className="btn-brass"
            style={{ padding: "10px 20px", fontSize: "0.8125rem", borderRadius: 0 }}
          >
            + ASSIGN ASSET →
          </button>
        )}
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

      {/* Asset Table */}
      {assets.length === 0 ? (
        <div
          style={{
            padding: "32px 24px",
            border: "1px dashed rgba(255, 255, 255, 0.12)",
            backgroundColor: "rgba(255, 255, 255, 0.01)",
            borderRadius: 0,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "16px",
          }}
        >
          <p
            style={{
              color: "var(--text-secondary)",
              fontSize: "0.875rem",
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            {heirs.length === 0
              ? "Add an heir first, then choose what they receive."
              : "Nothing assigned yet. Pick a token, NFT or ENS name and who receives it."}
          </p>
          {isGreen && heirs.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setSelectedHeir(heirs[0]);
                setShowAssignModal(true);
              }}
              className="btn-hero-action"
              style={{ padding: "10px 20px", fontSize: "0.8125rem", borderRadius: 0, marginTop: 0 }}
            >
              <span>+ Assign first asset →</span>
            </button>
          )}
        </div>
      ) : (
        <div>
          {readiness && (
            <AllocationReadinessBanner readiness={readiness} perspective="owner" isLoading={isCheckingHealth} />
          )}
          {tableError && (
            <p role="alert" style={{ color: "var(--status-red)", fontSize: "0.8125rem", margin: "0 0 12px" }}>
              {tableError}
            </p>
          )}
        <div
          style={{
            border: "1px solid rgba(255, 255, 255, 0.15)",
            borderRadius: 0,
            overflow: "hidden",
          }}
        >
          <table className="table-instrument">
            <thead>
              <tr style={{ backgroundColor: "var(--bg-elevated)" }}>
                <th>ASSET / TYPE</th>
                <th>ASSIGNED HEIR</th>
                <th>EXECUTOR ADAPTER</th>
                <th>STATUS</th>
                {isGreen && <th style={{ textAlign: "right" }}>ACTION</th>}
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => (
                <tr key={asset.assetId}>
                  <td>
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      <span style={{ fontWeight: 500, color: "var(--text-primary)" }}>
                        {asset.label}
                      </span>
                      <span
                        style={{
                          fontSize: "0.75rem",
                          color: "var(--text-secondary)",
                          marginTop: "2px",
                        }}
                      >
                        Type: {asset.assetType}
                      </span>
                    </div>
                  </td>
                  <td>
                    <AddressChip address={asset.heir} truncate badge="" size="sm" />
                  </td>
                  <td>
                    <AddressChip address={asset.executor} truncate badge="" size="sm" />
                  </td>
                  <td>
                    {asset.allocation ? (
                      <AllocationHealthBadge
                        allocation={asset.allocation}
                        health={health?.[asset.assetId]}
                        perspective="owner"
                        onRestoreApproval={onRestoreApproval ? () => handleRestoreApproval(asset.assetId) : undefined}
                        isRestoring={restoringAssetId === asset.assetId}
                      />
                    ) : (
                      <span
                        style={{
                          padding: "3px 8px",
                          borderRadius: 0,
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          backgroundColor: asset.executed
                            ? "rgba(154, 158, 152, 0.2)"
                            : "rgba(184, 137, 74, 0.18)",
                          color: asset.executed
                            ? "var(--text-secondary)"
                            : "var(--accent-brass)",
                        }}
                      >
                        {asset.executed ? "Claimed" : "Assigned"}
                      </span>
                    )}
                  </td>
                  {isGreen && (
                    <td style={{ textAlign: "right" }}>
                      {!asset.executed && (
                        <button
                          type="button"
                          onClick={() => handleRemove(asset.assetId)}
                          disabled={isSubmitting}
                          className="btn-secondary"
                          style={{
                            padding: "4px 10px",
                            fontSize: "0.75rem",
                            color: "var(--text-secondary)",
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </div>
      )}

      {/* Asset Assignment Modal */}
      {showAssignModal && (
        <div
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(8, 11, 15, 0.88)",
            backdropFilter: "blur(12px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "16px",
          }}
        >
          <div
            ref={assignDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="assign-asset-title"
            style={{
              width: "100%",
              maxWidth: "520px",
              backgroundColor: "var(--bg-elevated)",
              border: "1px solid rgba(184, 137, 74, 0.35)",
              boxShadow: "0 24px 64px rgba(0, 0, 0, 0.85), 0 0 40px rgba(184, 137, 74, 0.08)",
              display: "flex",
              flexDirection: "column",
              // Scroll inside the dialog on short screens instead of clipping the action buttons
              maxHeight: "calc(100dvh - 32px)",
              overflowY: "auto",
            }}
          >
            {/* Modal Top Bar */}
            <div
              style={{
                padding: "20px 24px 16px 24px",
                borderBottom: "1px solid var(--border-hairline)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                backgroundColor: "rgba(255, 255, 255, 0.02)",
              }}
            >
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    marginBottom: "6px",
                  }}
                >
                  <span
                    style={{
                      width: "6px",
                      height: "6px",
                      borderRadius: "50%",
                      backgroundColor: "var(--accent-brass)",
                      boxShadow: "0 0 8px var(--accent-brass)",
                    }}
                  />
                  <span
                    style={{
                      fontSize: "0.6875rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.12em",
                      color: "var(--accent-brass)",
                      fontWeight: 700,
                    }}
                  >
                    World Chain Sepolia
                  </span>
                </div>
                <h3
                  id="assign-asset-title"
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
                  Assign an asset
                </h3>
              </div>
              <button
                type="button"
                onClick={closeModal}
                disabled={isSubmitting}
                aria-label="Close dialog"
                className="btn-secondary"
                style={{ padding: "4px 10px", fontSize: "0.75rem", borderRadius: 0 }}
              >
                Close ✕
              </button>
            </div>

            {/* Mode Switcher Segmented Control */}
            <div
              role="tablist"
              aria-label="Asset type"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                padding: "4px",
                margin: "16px 24px 0 24px",
                backgroundColor: "rgba(0, 0, 0, 0.4)",
                border: "1px solid rgba(255, 255, 255, 0.08)",
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={modalMode === "TOKENS"}
                onClick={() => {
                  setModalMode("TOKENS");
                  setIsSelectingToken(false);
                }}
                disabled={isSubmitting}
                style={{
                  padding: "8px 12px",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  border: "none",
                  cursor: "pointer",
                  backgroundColor:
                    modalMode === "TOKENS"
                      ? "rgba(184, 137, 74, 0.18)"
                      : "transparent",
                  color: modalMode === "TOKENS" ? "#ffffff" : "var(--text-secondary)",
                  borderBottom:
                    modalMode === "TOKENS" ? "2px solid var(--accent-brass)" : "none",
                  transition: "all 0.15s ease",
                }}
              >
                Tokens (ERC-20)
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={modalMode === "EXECUTOR"}
                onClick={() => {
                  setModalMode("EXECUTOR");
                  setIsSelectingToken(false);
                }}
                disabled={isSubmitting}
                style={{
                  padding: "8px 12px",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  border: "none",
                  cursor: "pointer",
                  backgroundColor:
                    modalMode === "EXECUTOR"
                      ? "rgba(184, 137, 74, 0.18)"
                      : "transparent",
                  color: modalMode === "EXECUTOR" ? "#ffffff" : "var(--text-secondary)",
                  borderBottom:
                    modalMode === "EXECUTOR" ? "2px solid var(--accent-brass)" : "none",
                  transition: "all 0.15s ease",
                }}
              >
                NFT or ENS name
              </button>
            </div>

            {/* Modal Body */}
            <div style={{ padding: "20px 24px 24px 24px" }}>
              {/* VIEW A: DYNAMIC TOKEN SELECTOR / IMPORT OVERLAY */}
              {modalMode === "TOKENS" && isSelectingToken ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span
                      style={{
                        fontSize: "0.75rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        color: "var(--accent-brass)",
                        fontWeight: 700,
                      }}
                    >
                      Choose a token
                    </span>
                    <button
                      type="button"
                      onClick={() => setIsSelectingToken(false)}
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--text-secondary)",
                        fontSize: "0.75rem",
                        cursor: "pointer",
                        textDecoration: "underline",
                      }}
                    >
                      ← Back
                    </button>
                  </div>

                  {/* Search / Paste Address Input */}
                  <div style={{ position: "relative" }}>
                    <input
                      type="text"
                      className="input-instrument font-data"
                      placeholder="Search name, symbol, or paste contract 0x..."
                      value={searchQuery}
                      onChange={(e) => handleSearchChange(e.target.value)}
                      style={{ paddingRight: "40px", fontSize: "0.8125rem" }}
                      autoFocus
                    />
                    {isSearchingContract && (
                      <div
                        style={{
                          position: "absolute",
                          right: "12px",
                          top: "50%",
                          transform: "translateY(-50%)",
                          width: "14px",
                          height: "14px",
                          borderRadius: "50%",
                          border: "2px solid var(--accent-brass)",
                          borderTopColor: "transparent",
                          animation: "spin-cw 0.8s linear infinite",
                        }}
                      />
                    )}
                  </div>

                  {/* Filter Pills */}
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      onClick={() => setTokenFilter("ALL")}
                      style={{
                        padding: "4px 10px",
                        fontSize: "0.6875rem",
                        fontWeight: 600,
                        backgroundColor:
                          tokenFilter === "ALL"
                            ? "rgba(184, 137, 74, 0.2)"
                            : "rgba(255, 255, 255, 0.04)",
                        color: tokenFilter === "ALL" ? "var(--accent-brass)" : "var(--text-secondary)",
                        border:
                          tokenFilter === "ALL"
                            ? "1px solid var(--accent-brass)"
                            : "1px solid rgba(255, 255, 255, 0.1)",
                        cursor: "pointer",
                      }}
                    >
                      All Tokens ({displayTokens.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setTokenFilter("IN_WALLET")}
                      style={{
                        padding: "4px 10px",
                        fontSize: "0.6875rem",
                        fontWeight: 600,
                        backgroundColor:
                          tokenFilter === "IN_WALLET"
                            ? "rgba(184, 137, 74, 0.2)"
                            : "rgba(255, 255, 255, 0.04)",
                        color:
                          tokenFilter === "IN_WALLET"
                            ? "var(--accent-brass)"
                            : "var(--text-secondary)",
                        border:
                          tokenFilter === "IN_WALLET"
                            ? "1px solid var(--accent-brass)"
                            : "1px solid rgba(255, 255, 255, 0.1)",
                        cursor: "pointer",
                      }}
                    >
                      In Wallet (Balance &gt; 0)
                    </button>
                  </div>

                  {/* Imported Token Preview Card */}
                  {importedTokenCandidate && (
                    <div
                      style={{
                        padding: "12px",
                        backgroundColor: "rgba(184, 137, 74, 0.12)",
                        border: "1px solid var(--accent-brass)",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span style={{ fontWeight: 700, color: "#ffffff", fontSize: "0.9375rem" }}>
                            {importedTokenCandidate.symbol}
                          </span>
                          <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                            ({importedTokenCandidate.name})
                          </span>
                        </div>
                        <div style={{ fontSize: "0.75rem", color: "var(--accent-brass)", marginTop: "2px" }}>
                          Wallet Balance: {importedTokenCandidate.formattedBalance} {importedTokenCandidate.symbol}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleImportToken(importedTokenCandidate)}
                        className="btn-brass"
                        style={{ padding: "6px 12px", fontSize: "0.75rem" }}
                      >
                        + Import &amp; Select
                      </button>
                    </div>
                  )}

                  {searchContractError && (
                    <div style={{ fontSize: "0.75rem", color: "var(--status-red)" }}>
                      {searchContractError}
                    </div>
                  )}

                  {/* Dynamic Token List */}
                  <div
                    style={{
                      maxHeight: "220px",
                      overflowY: "auto",
                      display: "flex",
                      flexDirection: "column",
                      gap: "6px",
                      border: "1px solid rgba(255, 255, 255, 0.08)",
                      padding: "6px",
                      backgroundColor: "rgba(0, 0, 0, 0.2)",
                    }}
                  >
                    {filteredTokens.length === 0 ? (
                      <div
                        style={{
                          padding: "20px",
                          textAlign: "center",
                          color: "var(--text-secondary)",
                          fontSize: "0.8125rem",
                        }}
                      >
                        No matching tokens found. Paste any contract address above to import an ERC-20.
                      </div>
                    ) : (
                      filteredTokens.map((t) => {
                        const originalIdx = displayTokens.findIndex(
                          (item) =>
                            item.symbol === t.symbol &&
                            (item.address?.toLowerCase() === t.address?.toLowerCase() ||
                              (item.isNative && t.isNative))
                        );
                        const isCurrent = originalIdx === selectedTokenIndex;
                        const hasPositiveBal = t.balance && t.balance > 0n;

                        return (
                          <div
                            key={t.address || t.symbol}
                            onClick={() => {
                              setSelectedTokenIndex(originalIdx);
                              setIsSelectingToken(false);
                            }}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              padding: "10px 12px",
                              backgroundColor: isCurrent
                                ? "rgba(184, 137, 74, 0.15)"
                                : "rgba(255, 255, 255, 0.02)",
                              border: isCurrent
                                ? "1px solid var(--accent-brass)"
                                : "1px solid rgba(255, 255, 255, 0.05)",
                              cursor: "pointer",
                              transition: "all 0.15s ease",
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                              <div
                                style={{
                                  width: "32px",
                                  height: "32px",
                                  borderRadius: "50%",
                                  backgroundColor: "rgba(255, 255, 255, 0.08)",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  fontSize: "0.75rem",
                                  fontWeight: 800,
                                  color: isCurrent ? "var(--accent-brass)" : "#ffffff",
                                  border: isCurrent
                                    ? "1px solid var(--accent-brass)"
                                    : "1px solid rgba(255, 255, 255, 0.15)",
                                }}
                              >
                                {t.symbol.slice(0, 3)}
                              </div>
                              <div>
                                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                  <span style={{ fontWeight: 700, color: "#ffffff", fontSize: "0.875rem" }}>
                                    {t.symbol}
                                  </span>
                                  {t.isNative && (
                                    <span
                                      style={{
                                        fontSize: "0.625rem",
                                        padding: "1px 5px",
                                        backgroundColor: "rgba(255, 255, 255, 0.1)",
                                        color: "var(--text-secondary)",
                                      }}
                                    >
                                      Native · can&apos;t assign
                                    </span>
                                  )}
                                  {t.isCustom && (
                                    <span
                                      style={{
                                        fontSize: "0.625rem",
                                        padding: "1px 5px",
                                        backgroundColor: "rgba(184, 137, 74, 0.2)",
                                        color: "var(--accent-brass)",
                                      }}
                                    >
                                      Imported
                                    </span>
                                  )}
                                </div>
                                <div style={{ fontSize: "0.6875rem", color: "var(--text-secondary)", marginTop: "2px" }}>
                                  {t.name}
                                </div>
                              </div>
                            </div>

                            <div style={{ textAlign: "right" }}>
                              <div
                                style={{
                                  fontFamily: "monospace",
                                  fontWeight: 600,
                                  fontSize: "0.8125rem",
                                  color: hasPositiveBal ? "#ffffff" : "var(--text-secondary)",
                                }}
                              >
                                {t.formattedBalance ?? "0.00"} {t.symbol}
                              </div>
                              {hasPositiveBal && (
                                <div
                                  style={{
                                    fontSize: "0.625rem",
                                    color: "rgba(80, 200, 120, 1)",
                                    fontWeight: 600,
                                    marginTop: "2px",
                                  }}
                                >
                                  ● In Wallet
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : (
                /* VIEW B: MAIN ALLOCATION FORM */
                <form onSubmit={handleAssignSubmit} style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                  {modalMode === "TOKENS" ? (
                    <>
                      {/* Interactive Selected Token Card */}
                      <div>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: "6px",
                          }}
                        >
                          <label
                            style={{
                              fontSize: "0.75rem",
                              textTransform: "uppercase",
                              letterSpacing: "0.08em",
                              color: "var(--text-secondary)",
                              fontWeight: 600,
                            }}
                          >
                            Selected Asset
                          </label>
                          <button
                            type="button"
                            onClick={() => setIsSelectingToken(true)}
                            style={{
                              background: "none",
                              border: "none",
                              color: "var(--accent-brass)",
                              fontSize: "0.75rem",
                              fontWeight: 600,
                              cursor: "pointer",
                              display: "flex",
                              alignItems: "center",
                              gap: "4px",
                            }}
                          >
                            Change token ▾
                          </button>
                        </div>

                        <div
                          onClick={() => setIsSelectingToken(true)}
                          style={{
                            padding: "12px 14px",
                            backgroundColor: "rgba(255, 255, 255, 0.03)",
                            border: "1px solid rgba(212, 163, 89, 0.35)",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                            <div
                              style={{
                                width: "36px",
                                height: "36px",
                                borderRadius: "50%",
                                backgroundColor: "rgba(184, 137, 74, 0.18)",
                                border: "1px solid var(--accent-brass)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontWeight: 800,
                                fontSize: "0.8125rem",
                                color: "var(--accent-brass)",
                              }}
                            >
                              {selectedToken?.symbol.slice(0, 3)}
                            </div>
                            <div>
                              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                <span style={{ fontSize: "1rem", fontWeight: 700, color: "#ffffff" }}>
                                  {selectedToken?.symbol}
                                </span>
                                <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                                  ({selectedToken?.name})
                                </span>
                              </div>
                              <div style={{ fontSize: "0.6875rem", color: "var(--text-secondary)", marginTop: "2px" }}>
                                {selectedToken?.isNative
                                  ? "Native Gas Asset (World Chain Sepolia)"
                                  : `Contract: ${selectedToken?.address?.slice(0, 8)}...${selectedToken?.address?.slice(-6)}`}
                              </div>
                            </div>
                          </div>

                          <div style={{ textAlign: "right" }}>
                            <div style={{ fontSize: "0.6875rem", color: "var(--text-secondary)", textTransform: "uppercase" }}>
                              Available
                            </div>
                            <div
                              style={{
                                fontFamily: "monospace",
                                fontSize: "0.9375rem",
                                fontWeight: 700,
                                color: "var(--accent-brass)",
                              }}
                            >
                              {selectedToken?.isNative && isEthLoading ? (
                                <Skeleton width="60px" height="16px" />
                              ) : (
                                `${selectedToken?.formattedBalance ?? "0.00"} ${selectedToken?.symbol}`
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Native ETH not supported for automated succession */}
                      {selectedToken?.isNative && (
                        <div
                          style={{
                            padding: "10px 12px",
                            backgroundColor: "rgba(184, 137, 74, 0.1)",
                            border: "1px solid var(--accent-brass)",
                            fontSize: "0.8125rem",
                            color: "var(--text-primary)",
                            lineHeight: 1.4,
                          }}
                        >
                          Native ETH isn&apos;t supported for succession allocation. Select <strong>testnet USDC</strong> or wrap ETH to <strong>WETH</strong> to continue.
                        </div>
                      )}

                      {/* Official Circle Faucet Callout */}
                      {selectedToken?.symbol === "USDC" && parseFloat(selectedToken?.formattedBalance ?? "0") === 0 && (
                        <div
                          style={{
                            padding: "12px 14px",
                            backgroundColor: "rgba(184, 137, 74, 0.1)",
                            border: "1px solid var(--accent-brass)",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            flexWrap: "wrap",
                            gap: "8px",
                          }}
                        >
                          <div>
                            <div style={{ fontSize: "0.8125rem", fontWeight: 700, color: "var(--accent-brass)" }}>
                              No test USDC in this wallet yet
                            </div>
                            <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "2px" }}>
                              Get free testnet USDC from the Circle faucet, then come back.
                            </div>
                          </div>
                          <a
                            href="https://faucet.circle.com"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-brass"
                            style={{
                              padding: "6px 14px",
                              fontSize: "0.75rem",
                              borderRadius: 0,
                              textDecoration: "none",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                            }}
                          >
                            <span>Open Circle Faucet ↗</span>
                          </a>
                        </div>
                      )}

                      {/* DeFi Amount Input Card */}
                      <div
                        style={{
                          padding: "16px",
                          backgroundColor: "rgba(0, 0, 0, 0.35)",
                          border: "1px solid rgba(255, 255, 255, 0.1)",
                          display: "flex",
                          flexDirection: "column",
                          gap: "12px",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span
                            style={{
                              fontSize: "0.75rem",
                              textTransform: "uppercase",
                              letterSpacing: "0.08em",
                              color: "var(--text-secondary)",
                              fontWeight: 600,
                            }}
                          >
                            Allocation Amount
                          </span>
                          <div style={{ display: "flex", gap: "6px" }}>
                            <button
                              type="button"
                              onClick={() => handleSetPercentage(25)}
                              className="btn-secondary"
                              style={{ padding: "2px 8px", fontSize: "0.6875rem", borderRadius: 0 }}
                            >
                              25%
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSetPercentage(50)}
                              className="btn-secondary"
                              style={{ padding: "2px 8px", fontSize: "0.6875rem", borderRadius: 0 }}
                            >
                              50%
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSetPercentage(75)}
                              className="btn-secondary"
                              style={{ padding: "2px 8px", fontSize: "0.6875rem", borderRadius: 0 }}
                            >
                              75%
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSetPercentage(100)}
                              className="btn-secondary"
                              style={{
                                padding: "2px 8px",
                                fontSize: "0.6875rem",
                                borderRadius: 0,
                                color: "var(--accent-brass)",
                                borderColor: "var(--accent-brass)",
                                fontWeight: 700,
                              }}
                            >
                              MAX
                            </button>
                          </div>
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                          <input
                            type="number"
                            step="any"
                            min="0"
                            placeholder="0.00"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            style={{
                              flex: 1,
                              background: "none",
                              border: "none",
                              outline: "none",
                              color: "#ffffff",
                              fontSize: "1.75rem",
                              fontWeight: 800,
                              fontFamily: "var(--font-data)",
                              padding: 0,
                            }}
                            required
                          />
                          <span
                            style={{
                              fontSize: "1rem",
                              fontWeight: 800,
                              color: "var(--accent-brass)",
                              padding: "4px 8px",
                              backgroundColor: "rgba(184, 137, 74, 0.12)",
                              border: "1px solid rgba(184, 137, 74, 0.3)",
                            }}
                          >
                            {selectedToken?.symbol}
                          </span>
                        </div>

                        {/* Allocation Proportion Bar */}
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                          <div
                            style={{
                              height: "4px",
                              backgroundColor: "rgba(255, 255, 255, 0.08)",
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                height: "100%",
                                width: `${allocationPercent}%`,
                                backgroundColor:
                                  allocationPercent > 100
                                    ? "var(--status-red)"
                                    : "var(--accent-brass)",
                                transition: "width 0.2s ease",
                              }}
                            />
                          </div>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              fontSize: "0.6875rem",
                              color: "var(--text-secondary)",
                              fontFamily: "monospace",
                            }}
                          >
                            <span>Allocating {allocationPercent.toFixed(1)}% of wallet balance</span>
                            <span>Bal: {selectedToken?.formattedBalance ?? "0.00"}</span>
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    /* Advanced Mode Inputs */
                    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                      <div>
                        <label style={{ fontSize: "0.75rem", color: "var(--text-secondary)", display: "block", marginBottom: "6px" }}>
                          Name (so you and your heir can recognise it)
                        </label>
                        <input
                          type="text"
                          className="input-instrument"
                          placeholder="e.g. Rare Artifact #1024"
                          value={manualLabel}
                          onChange={(e) => setManualLabel(e.target.value)}
                          required
                        />
                      </div>

                      <div>
                        <label style={{ fontSize: "0.75rem", color: "var(--text-secondary)", display: "block", marginBottom: "6px" }}>
                          What are you assigning?
                        </label>
                        <select
                          value={manualAssetType}
                          onChange={(e) => setManualAssetType(e.target.value as "ERC20" | "ERC721" | "ENS")}
                          className="input-instrument"
                          style={{ backgroundColor: "var(--bg-base)" }}
                        >
                          <option value="ERC20">Token (ERC-20)</option>
                          <option value="ERC721">NFT (ERC-721)</option>
                          <option value="ENS">ENS name</option>
                        </select>
                      </div>

                      <div>
                        <label style={{ fontSize: "0.75rem", color: "var(--text-secondary)", display: "block", marginBottom: "6px" }}>
                          Adapter contract address
                        </label>
                        <input
                          type="text"
                          className="input-instrument font-data"
                          placeholder="0x… address of the deployed adapter"
                          value={manualExecutorAddress}
                          onChange={(e) => setManualExecutorAddress(e.target.value)}
                          required
                        />
                      </div>
                    </div>
                  )}

                  {/* Designated Heir Selector */}
                  <div>
                    <label
                      style={{
                        fontSize: "0.75rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        color: "var(--text-secondary)",
                        display: "block",
                        marginBottom: "6px",
                        fontWeight: 600,
                      }}
                    >
                      Who receives it
                    </label>
                    <select
                      value={selectedHeir}
                      onChange={(e) => setSelectedHeir(e.target.value)}
                      className="input-instrument font-data"
                      style={{ backgroundColor: "var(--bg-base)" }}
                    >
                      {heirs.map((h, i) => (
                        <option key={h} value={h}>
                          Heir #{i + 1} — {h.slice(0, 8)}…{h.slice(-6)}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Execution Progress HUD */}
                  {executionStage && (
                    <div
                      style={{
                        padding: "12px 14px",
                        backgroundColor: "rgba(184, 137, 74, 0.12)",
                        border: "1px solid var(--accent-brass)",
                        fontSize: "0.8125rem",
                        color: "var(--accent-brass)",
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                      }}
                    >
                      <div
                        style={{
                          width: "14px",
                          height: "14px",
                          borderRadius: "50%",
                          border: "2px solid var(--accent-brass)",
                          borderTopColor: "transparent",
                          animation: "spin-cw 0.8s linear infinite",
                          flexShrink: 0,
                        }}
                      />
                      <span>{executionStage}</span>
                    </div>
                  )}

                  {/* Error Alert */}
                  {errorText && (
                    <div
                      style={{
                        padding: "10px 14px",
                        backgroundColor: "rgba(193, 80, 63, 0.15)",
                        border: "1px solid var(--status-red)",
                        borderRadius: 0,
                        fontSize: "0.8125rem",
                        color: "var(--text-primary)",
                        lineHeight: 1.4,
                      }}
                    >
                      {errorText}
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div
                    style={{
                      display: "flex",
                      gap: "10px",
                      marginTop: "4px",
                      // Pinned so Cancel / Confirm stay reachable when the dialog scrolls on short screens
                      position: "sticky",
                      bottom: 0,
                      marginBottom: -24,
                      paddingTop: 12,
                      paddingBottom: 24,
                      backgroundColor: "var(--bg-elevated)",
                    }}
                  >
                    <button
                      type="button"
                      onClick={closeModal}
                      disabled={isSubmitting}
                      className="btn-secondary"
                      style={{ flex: 1, padding: "12px", borderRadius: 0, fontSize: "0.8125rem" }}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isSubmitting || isTokenFormIncomplete}
                      title={isTokenFormIncomplete && !selectedToken?.isNative ? "Fill in every field to continue" : undefined}
                      className="btn-brass"
                      style={{
                        flex: 2,
                        padding: "12px",
                        borderRadius: 0,
                        fontSize: "0.8125rem",
                        fontWeight: 700,
                        opacity: isTokenFormIncomplete ? 0.5 : 1,
                        cursor: isTokenFormIncomplete ? "not-allowed" : "pointer",
                      }}
                    >
                      {isSubmitting
                        ? "Confirm in your wallet…"
                        : modalMode === "EXECUTOR"
                        ? "Assign asset →"
                        : `Assign ${amount ? `${amount} ` : ""}${selectedToken?.symbol} to heir →`}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
