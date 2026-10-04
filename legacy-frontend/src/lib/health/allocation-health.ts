import {
  type PublicClient,
  parseAbi,
  parseAbiItem,
  formatUnits,
} from "viem";

export class LogsLoadError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "LogsLoadError";
  }
}

export interface AllocationItem {
  assetId: `0x${string}`;
  heir: `0x${string}`;
  executor: `0x${string}`;
  executed: boolean;
}

export type AdapterKind = "ERC20" | "ERC721" | "ENS" | "UNKNOWN";

export type HealthState = "funded" | "underfunded" | "unknown" | "claimed";

export type HealthReason =
  | "ok"
  | "balance_too_low"
  | "allowance_too_low"
  | "shared_balance_exceeded"
  | "nft_not_owned"
  | "nft_not_approved"
  | "ens_not_owned"
  | "adapter_unrecognized"
  | "read_failed";

export interface AllocationHealth {
  assetId: `0x${string}`;
  heir: `0x${string}`;
  executor: `0x${string}`;
  executed: boolean;
  kind: AdapterKind;
  state: HealthState;
  reason: HealthReason;
  label?: string;
  details?: string;
  tokenAddress?: `0x${string}`;
  amount?: bigint;
  decimals?: number;
  symbol?: string;
}

export interface HealthSummary {
  total: number;
  funded: number;
  underfunded: number;
  unknown: number;
}

// Minimal local ABIs via parseAbi — do NOT modify generated abis.ts / adapters.ts
const VAULT_ALLOCATION_ABI = parseAbi([
  "function allocations(bytes32 assetId) view returns (address heir, address executor, bytes32 assetId, bool exists, bool executed)",
]);

const ASSET_ASSIGNED_EVENT = parseAbiItem(
  "event AssetAssigned(bytes32 indexed assetId, address indexed heir, address indexed executor)"
);
const ASSET_REMOVED_EVENT = parseAbiItem(
  "event AssetRemoved(bytes32 indexed assetId)"
);

const ERC20_PROBE_ABI = parseAbi([
  "function token() view returns (address)",
  "function amount() view returns (uint256)",
]);

const ERC721_PROBE_ABI = parseAbi([
  "function tokenContract() view returns (address)",
  "function tokenId() view returns (uint256)",
]);

const ENS_PROBE_ABI = parseAbi([
  "function registry() view returns (address)",
  "function node() view returns (bytes32)",
  "function checkOwnership(address expectedOwner) view returns (bool)",
]);

const ERC20_EXTRA_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const ERC721_EXTRA_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
]);

/**
 * Concurrency helper: processes items in chunks to avoid overwhelming RPC,
 * without using multicall3 (which is not configured on World Chain Sepolia).
 */
async function mapInChunks<T, R>(
  items: readonly T[],
  chunkSize: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const chunkResults = await Promise.all(chunk.map((item) => fn(item)));
    results.push(...chunkResults);
  }
  return results;
}

/**
 * Load on-chain allocations for a vault from AssetAssigned and AssetRemoved logs.
 * Throws LogsLoadError on getLogs failure.
 */
export async function loadVaultAllocations(
  client: PublicClient,
  vault: `0x${string}`
): Promise<AllocationItem[]> {
  let assignedLogs;
  let removedLogs;
  try {
    [assignedLogs, removedLogs] = await Promise.all([
      client.getLogs({
        address: vault,
        event: ASSET_ASSIGNED_EVENT,
        fromBlock: 0n,
        toBlock: "latest",
      }),
      client.getLogs({
        address: vault,
        event: ASSET_REMOVED_EVENT,
        fromBlock: 0n,
        toBlock: "latest",
      }),
    ]);
  } catch (err: unknown) {
    throw new LogsLoadError("Failed to fetch vault allocation logs", err);
  }

  // Deduplicate all assetIds found across assigned and removed logs
  const candidateAssetIds = Array.from(
    new Set([
      ...assignedLogs
        .map((log) => log.args.assetId)
        .filter((id): id is `0x${string}` => Boolean(id)),
      ...removedLogs
        .map((log) => log.args.assetId)
        .filter((id): id is `0x${string}` => Boolean(id)),
    ])
  );

  if (candidateAssetIds.length === 0) return [];

  // Query allocations(assetId) in small chunks of 10
  const queried = await mapInChunks(candidateAssetIds, 10, async (assetId) => {
    try {
      const res = await client.readContract({
        address: vault,
        abi: VAULT_ALLOCATION_ABI,
        functionName: "allocations",
        args: [assetId],
      });
      const [heir, executor, , exists, executed] = res as [
        `0x${string}`,
        `0x${string}`,
        `0x${string}`,
        boolean,
        boolean
      ];
      if (exists) {
        return { assetId, heir, executor, executed } satisfies AllocationItem;
      }
      return null;
    } catch {
      return null;
    }
  });

  return queried.filter((item): item is AllocationItem => item !== null);
}

export type ProbeResult =
  | { kind: "ERC20"; token: `0x${string}`; amount: bigint }
  | { kind: "ERC721"; tokenContract: `0x${string}`; tokenId: bigint }
  | { kind: "ENS"; registry: `0x${string}`; node: `0x${string}` }
  | { kind: "UNKNOWN" };

/**
 * Probe an executor adapter contract using Promise.allSettled to detect its kind.
 */
export async function probeAdapter(
  client: PublicClient,
  executor: `0x${string}`
): Promise<ProbeResult> {
  const [erc20Probe, erc721Probe, ensProbe] = await Promise.allSettled([
    Promise.all([
      client.readContract({
        address: executor,
        abi: ERC20_PROBE_ABI,
        functionName: "token",
      }),
      client.readContract({
        address: executor,
        abi: ERC20_PROBE_ABI,
        functionName: "amount",
      }),
    ]),
    Promise.all([
      client.readContract({
        address: executor,
        abi: ERC721_PROBE_ABI,
        functionName: "tokenContract",
      }),
      client.readContract({
        address: executor,
        abi: ERC721_PROBE_ABI,
        functionName: "tokenId",
      }),
    ]),
    Promise.all([
      client.readContract({
        address: executor,
        abi: ENS_PROBE_ABI,
        functionName: "registry",
      }),
      client.readContract({
        address: executor,
        abi: ENS_PROBE_ABI,
        functionName: "node",
      }),
    ]),
  ]);

  if (erc20Probe.status === "fulfilled") {
    const [token, amount] = erc20Probe.value as [`0x${string}`, bigint];
    return { kind: "ERC20", token, amount };
  }
  if (erc721Probe.status === "fulfilled") {
    const [tokenContract, tokenId] = erc721Probe.value as [`0x${string}`, bigint];
    return { kind: "ERC721", tokenContract, tokenId };
  }
  if (ensProbe.status === "fulfilled") {
    const [registry, node] = ensProbe.value as [`0x${string}`, `0x${string}`];
    return { kind: "ENS", registry, node };
  }

  return { kind: "UNKNOWN" };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Pure classification functions (testable without a chain)
 * ───────────────────────────────────────────────────────────────────────────── */

export function classifyErc20Allocation(
  balance: bigint,
  allowance: bigint,
  amount: bigint
): { state: HealthState; reason: HealthReason } {
  if (balance < amount) {
    return { state: "underfunded", reason: "balance_too_low" };
  }
  if (allowance < amount) {
    return { state: "underfunded", reason: "allowance_too_low" };
  }
  return { state: "funded", reason: "ok" };
}

export function classifyErc721Allocation(
  ownerOf: `0x${string}`,
  expectedOwner: `0x${string}`,
  approved: `0x${string}`,
  isApprovedForAll: boolean,
  executor: `0x${string}`
): { state: HealthState; reason: HealthReason } {
  if (ownerOf.toLowerCase() !== expectedOwner.toLowerCase()) {
    return { state: "underfunded", reason: "nft_not_owned" };
  }
  const isApproved =
    approved.toLowerCase() === executor.toLowerCase() || isApprovedForAll;
  if (!isApproved) {
    return { state: "underfunded", reason: "nft_not_approved" };
  }
  return { state: "funded", reason: "ok" };
}

export function classifyEnsAllocation(
  isOwner: boolean
): { state: HealthState; reason: HealthReason; details: string } {
  if (!isOwner) {
    return {
      state: "underfunded",
      reason: "ens_not_owned",
      details: "Approval is not verified for names",
    };
  }
  return {
    state: "funded",
    reason: "ok",
    details: "Approval is not verified for names",
  };
}

/**
 * Apply the shared-balance rule across all non-executed ERC-20 allocations:
 * If the sum of required amounts across all allocations of a given token exceeds the owner's balance,
 * mark every allocation of that token underfunded with reason shared_balance_exceeded.
 */
export function applySharedBalanceRule(
  items: AllocationHealth[],
  balancesByToken: Map<string, bigint>
): AllocationHealth[] {
  // Compute sum of required amounts per token across all non-executed ERC-20 items
  const requiredSumByToken = new Map<string, bigint>();
  for (const item of items) {
    if (item.executed || item.kind !== "ERC20" || !item.tokenAddress || item.amount === undefined) {
      continue;
    }
    const key = item.tokenAddress.toLowerCase();
    const current = requiredSumByToken.get(key) ?? 0n;
    requiredSumByToken.set(key, current + item.amount);
  }

  // Tokens that exceed the owner's balance
  const exceededTokens = new Set<string>();
  for (const [tokenKey, requiredSum] of requiredSumByToken.entries()) {
    const ownerBal = balancesByToken.get(tokenKey) ?? 0n;
    if (requiredSum > ownerBal) {
      exceededTokens.add(tokenKey);
    }
  }

  return items.map((item) => {
    if (item.executed || item.kind !== "ERC20" || !item.tokenAddress) {
      return item;
    }
    const key = item.tokenAddress.toLowerCase();
    if (exceededTokens.has(key)) {
      return {
        ...item,
        state: "underfunded",
        reason: "shared_balance_exceeded",
      };
    }
    return item;
  });
}

/**
 * Assess health of all allocations for a given vault and owner.
 * Returns one AllocationHealth per allocation.
 */
export async function assessAllocations(
  client: PublicClient,
  vault: `0x${string}`,
  owner: `0x${string}`,
  allocations: AllocationItem[]
): Promise<AllocationHealth[]> {
  const probeCache = new Map<string, ProbeResult>();

  // Probe all unique executors in chunks of 10
  const uniqueExecutors = Array.from(
    new Set(allocations.map((a) => a.executor.toLowerCase()))
  ) as `0x${string}`[];

  await mapInChunks(uniqueExecutors, 10, async (executor) => {
    try {
      const result = await probeAdapter(client, executor);
      probeCache.set(executor.toLowerCase(), result);
    } catch {
      probeCache.set(executor.toLowerCase(), { kind: "UNKNOWN" });
    }
  });

  const tokenBalances = new Map<string, bigint>();
  const initialResults: AllocationHealth[] = [];

  for (const alloc of allocations) {
    if (alloc.executed) {
      const probe = probeCache.get(alloc.executor.toLowerCase());
      initialResults.push({
        assetId: alloc.assetId,
        heir: alloc.heir,
        executor: alloc.executor,
        executed: true,
        kind: probe?.kind ?? "UNKNOWN",
        state: "claimed",
        reason: "ok",
      });
      continue;
    }

    const probe = probeCache.get(alloc.executor.toLowerCase()) ?? { kind: "UNKNOWN" };

    if (probe.kind === "UNKNOWN") {
      initialResults.push({
        assetId: alloc.assetId,
        heir: alloc.heir,
        executor: alloc.executor,
        executed: false,
        kind: "UNKNOWN",
        state: "unknown",
        reason: "adapter_unrecognized",
      });
      continue;
    }

    if (probe.kind === "ERC20") {
      const token = probe.token;
      const amount = probe.amount;
      const tokenKey = token.toLowerCase();

      try {
        const [balRes, allowRes, decRes, symRes] = await Promise.allSettled([
          client.readContract({
            address: token,
            abi: ERC20_EXTRA_ABI,
            functionName: "balanceOf",
            args: [owner],
          }),
          client.readContract({
            address: token,
            abi: ERC20_EXTRA_ABI,
            functionName: "allowance",
            args: [owner, alloc.executor],
          }),
          client.readContract({
            address: token,
            abi: ERC20_EXTRA_ABI,
            functionName: "decimals",
          }),
          client.readContract({
            address: token,
            abi: ERC20_EXTRA_ABI,
            functionName: "symbol",
          }),
        ]);

        if (balRes.status !== "fulfilled" || allowRes.status !== "fulfilled") {
          initialResults.push({
            assetId: alloc.assetId,
            heir: alloc.heir,
            executor: alloc.executor,
            executed: false,
            kind: "ERC20",
            state: "unknown",
            reason: "read_failed",
            tokenAddress: token,
            amount,
          });
          continue;
        }

        const balance = balRes.value as bigint;
        const allowance = allowRes.value as bigint;
        const decimals = decRes.status === "fulfilled" ? Number(decRes.value) : 18;
        const symbol = symRes.status === "fulfilled" ? String(symRes.value) : "tokens";

        tokenBalances.set(tokenKey, balance);

        const { state, reason } = classifyErc20Allocation(balance, allowance, amount);
        const formattedAmount = formatUnits(amount, decimals);
        const label = `${formattedAmount} ${symbol}`;

        initialResults.push({
          assetId: alloc.assetId,
          heir: alloc.heir,
          executor: alloc.executor,
          executed: false,
          kind: "ERC20",
          state,
          reason,
          label,
          tokenAddress: token,
          amount,
          decimals,
          symbol,
        });
      } catch {
        initialResults.push({
          assetId: alloc.assetId,
          heir: alloc.heir,
          executor: alloc.executor,
          executed: false,
          kind: "ERC20",
          state: "unknown",
          reason: "read_failed",
          tokenAddress: token,
          amount,
        });
      }
      continue;
    }

    if (probe.kind === "ERC721") {
      const { tokenContract, tokenId } = probe;
      const label = `NFT #${tokenId.toString()}`;

      try {
        const [ownerRes, approvedRes, allApprovedRes] = await Promise.allSettled([
          client.readContract({
            address: tokenContract,
            abi: ERC721_EXTRA_ABI,
            functionName: "ownerOf",
            args: [tokenId],
          }),
          client.readContract({
            address: tokenContract,
            abi: ERC721_EXTRA_ABI,
            functionName: "getApproved",
            args: [tokenId],
          }),
          client.readContract({
            address: tokenContract,
            abi: ERC721_EXTRA_ABI,
            functionName: "isApprovedForAll",
            args: [owner, alloc.executor],
          }),
        ]);

        if (ownerRes.status !== "fulfilled") {
          initialResults.push({
            assetId: alloc.assetId,
            heir: alloc.heir,
            executor: alloc.executor,
            executed: false,
            kind: "ERC721",
            state: "unknown",
            reason: "read_failed",
            label,
          });
          continue;
        }

        const ownerOf = ownerRes.value as `0x${string}`;
        const approved =
          approvedRes.status === "fulfilled"
            ? (approvedRes.value as `0x${string}`)
            : ("0x0000000000000000000000000000000000000000" as `0x${string}`);
        const isApprovedForAll =
          allApprovedRes.status === "fulfilled" ? Boolean(allApprovedRes.value) : false;

        const { state, reason } = classifyErc721Allocation(
          ownerOf,
          owner,
          approved,
          isApprovedForAll,
          alloc.executor
        );

        initialResults.push({
          assetId: alloc.assetId,
          heir: alloc.heir,
          executor: alloc.executor,
          executed: false,
          kind: "ERC721",
          state,
          reason,
          label,
        });
      } catch {
        initialResults.push({
          assetId: alloc.assetId,
          heir: alloc.heir,
          executor: alloc.executor,
          executed: false,
          kind: "ERC721",
          state: "unknown",
          reason: "read_failed",
          label,
        });
      }
      continue;
    }

    if (probe.kind === "ENS") {
      const label = "ENS Name";
      try {
        const isOwner = await client.readContract({
          address: alloc.executor,
          abi: ENS_PROBE_ABI,
          functionName: "checkOwnership",
          args: [owner],
        });

        const { state, reason, details } = classifyEnsAllocation(Boolean(isOwner));
        initialResults.push({
          assetId: alloc.assetId,
          heir: alloc.heir,
          executor: alloc.executor,
          executed: false,
          kind: "ENS",
          state,
          reason,
          label,
          details,
        });
      } catch {
        initialResults.push({
          assetId: alloc.assetId,
          heir: alloc.heir,
          executor: alloc.executor,
          executed: false,
          kind: "ENS",
          state: "unknown",
          reason: "read_failed",
          label,
          details: "Approval is not verified for names",
        });
      }
      continue;
    }
  }

  // Apply shared balance rule across all non-executed ERC-20 allocations
  return applySharedBalanceRule(initialResults, tokenBalances);
}

/**
 * Summarize health of allocations for dashboard/portal cards.
 * Claimed allocations are excluded from the total.
 */
export function summarizeHealth(items: AllocationHealth[]): HealthSummary {
  let funded = 0;
  let underfunded = 0;
  let unknown = 0;
  let total = 0;

  for (const item of items) {
    if (item.state === "claimed") continue;
    total++;
    if (item.state === "funded") funded++;
    else if (item.state === "underfunded") underfunded++;
    else if (item.state === "unknown") unknown++;
  }

  return { total, funded, underfunded, unknown };
}

export function getHealthReasonMessage(reason: HealthReason): string {
  switch (reason) {
    case "ok":
      return "Funded";
    case "balance_too_low":
      return "Wallet balance is lower than this amount";
    case "allowance_too_low":
      return "Approval was removed";
    case "shared_balance_exceeded":
      return "Another asset uses the same tokens";
    case "nft_not_owned":
      return "NFT is not in wallet";
    case "nft_not_approved":
      return "NFT transfer is not approved";
    case "ens_not_owned":
      return "ENS name is not owned by wallet";
    case "adapter_unrecognized":
      return "Unrecognized executor adapter";
    case "read_failed":
    default:
      return "Couldn't verify right now";
  }
}

export function getHealthLabel(state: HealthState): string {
  switch (state) {
    case "funded":
      return "Funded";
    case "underfunded":
      return "Underfunded";
    case "claimed":
      return "Claimed";
    case "unknown":
    default:
      return "Couldn't verify";
  }
}
