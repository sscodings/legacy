// On-chain allocations and their "health": would each one actually pay out
// if the heir claimed right now?
//
// A LegacyVault never holds assets. An allocation is a standing permission:
// at claim time the executor adapter pulls the asset straight from the
// owner's wallet. So it only pays out if, at that moment, the owner still
// holds the asset AND the adapter is still approved to move it. Neither is
// guaranteed — spending the tokens, selling the NFT or revoking an approval
// all silently break an allocation while the vault keeps looking healthy.
// This module checks both, per asset type.

import { formatUnits, getAbiItem, parseAbi, type PublicClient } from "viem";
import { LegacyVaultABI } from "@/lib/contracts/abis";

type Address = `0x${string}`;
type Hex = `0x${string}`;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const executorAbi = parseAbi([
  "function checkOwnership(address owner) view returns (bool)",
  // ERC20Adapter
  "function token() view returns (address)",
  "function amount() view returns (uint256)",
  // ERC721Adapter
  "function tokenContract() view returns (address)",
  "function tokenId() view returns (uint256)",
  // ENSResolverAdapter
  "function registry() view returns (address)",
  "function node() view returns (bytes32)",
]);

const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const erc721Abi = parseAbi([
  "function symbol() view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function approve(address to, uint256 tokenId)",
]);

const ensRegistryAbi = parseAbi([
  "function owner(bytes32 node) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
]);

export { erc20Abi as allocationErc20Abi, erc721Abi as allocationErc721Abi };

export type AllocationAsset =
  | { kind: "ERC20"; token: Address; amount: bigint; symbol: string; decimals: number }
  | { kind: "ERC721"; token: Address; tokenId: bigint; symbol: string }
  | { kind: "ENS"; registry: Address; node: Hex }
  | { kind: "OTHER" };

export interface VaultAllocation {
  assetId: Hex;
  heir: Address;
  executor: Address;
  executed: boolean;
  asset: AllocationAsset;
  /** Human-readable description derived from the adapter, e.g. "100 USDC". */
  label: string;
}

export type AllocationHealthState =
  /** Would transfer in full if claimed now. */
  | "backed"
  /** ERC-20: the owner holds less than the allocated amount. */
  | "short-balance"
  /** The adapter is no longer approved to move the asset. */
  | "missing-approval"
  /** ERC-721 / ENS / custom: the owner no longer holds the asset. */
  | "not-held"
  /** Already transferred to the heir. */
  | "claimed"
  /** The executor could not be queried. */
  | "unknown";

export interface AllocationHealth {
  state: AllocationHealthState;
  /** ERC-20 only: the owner's current balance. */
  balance?: bigint;
  /** ERC-20 only: the adapter's current allowance. */
  allowance?: bigint;
}

export type AllocationHealthMap = Record<Hex, AllocationHealth>;

const assetAssignedEvent = getAbiItem({ abi: LegacyVaultABI, name: "AssetAssigned" });

async function read<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch {
    return undefined;
  }
}

/** Identifies an executor adapter by the getters it exposes. */
export async function describeExecutor(client: PublicClient, executor: Address): Promise<AllocationAsset> {
  const call = <T>(functionName: string) =>
    read(client.readContract({ address: executor, abi: executorAbi, functionName } as never) as Promise<T>);

  const [token, amount] = await Promise.all([call<Address>("token"), call<bigint>("amount")]);
  if (token && amount !== undefined) {
    const [symbol, decimals] = await Promise.all([
      read(client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" })),
      read(client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })),
    ]);
    return { kind: "ERC20", token, amount, symbol: symbol ?? "tokens", decimals: decimals ?? 18 };
  }

  const [tokenContract, tokenId] = await Promise.all([call<Address>("tokenContract"), call<bigint>("tokenId")]);
  if (tokenContract && tokenId !== undefined) {
    const symbol = await read(client.readContract({ address: tokenContract, abi: erc721Abi, functionName: "symbol" }));
    return { kind: "ERC721", token: tokenContract, tokenId, symbol: symbol ?? "NFT" };
  }

  const [registry, node] = await Promise.all([call<Address>("registry"), call<Hex>("node")]);
  if (registry && node) {
    return { kind: "ENS", registry, node };
  }

  return { kind: "OTHER" };
}

export function describeAsset(asset: AllocationAsset): string {
  switch (asset.kind) {
    case "ERC20":
      return `${formatUnits(asset.amount, asset.decimals)} ${asset.symbol}`;
    case "ERC721":
      return `${asset.symbol} #${asset.tokenId.toString()}`;
    case "ENS":
      return "ENS name";
    default:
      return "Custom asset";
  }
}

/**
 * Loads a vault's live allocations: discovered through AssetAssigned logs,
 * then read back from `allocations()` so removed or reassigned assets
 * reflect current state rather than history.
 */
export async function loadVaultAllocations(
  client: PublicClient,
  vault: Address,
  options: { heir?: Address } = {}
): Promise<VaultAllocation[]> {
  const logs = await client.getLogs({
    address: vault,
    event: assetAssignedEvent,
    args: options.heir ? { heir: options.heir } : undefined,
    fromBlock: 0n,
    toBlock: "latest",
  });

  const assetIds = Array.from(
    new Set(logs.map((log) => log.args.assetId).filter((id): id is Hex => Boolean(id)))
  );

  const allocations = await Promise.all(
    assetIds.map(async (assetId): Promise<VaultAllocation | null> => {
      const result = await read(
        client.readContract({ address: vault, abi: LegacyVaultABI, functionName: "allocations", args: [assetId] })
      );
      if (!result) return null;

      // allocations() returns [heir, executor, assetId, exists, executed]
      const [heir, executor, , exists, executed] = result as unknown as [Address, Address, Hex, boolean, boolean];
      if (!exists) return null;
      if (options.heir && heir.toLowerCase() !== options.heir.toLowerCase()) return null;

      const asset = await describeExecutor(client, executor);
      return { assetId, heir, executor, executed, asset, label: describeAsset(asset) };
    })
  );

  return allocations.filter((a): a is VaultAllocation => a !== null);
}

/** Checks whether one allocation would pay out if claimed right now. */
export async function checkAllocationHealth(
  client: PublicClient,
  owner: Address,
  allocation: VaultAllocation
): Promise<AllocationHealth> {
  if (allocation.executed) return { state: "claimed" };

  const { asset, executor } = allocation;

  if (asset.kind === "ERC20") {
    const [balance, allowance] = await Promise.all([
      read(client.readContract({ address: asset.token, abi: erc20Abi, functionName: "balanceOf", args: [owner] })),
      read(
        client.readContract({ address: asset.token, abi: erc20Abi, functionName: "allowance", args: [owner, executor] })
      ),
    ]);
    if (balance === undefined || allowance === undefined) return { state: "unknown" };
    // A shortfall in what the owner holds is the more fundamental problem:
    // re-approving would not help until the balance is restored.
    if (balance < asset.amount) return { state: "short-balance", balance, allowance };
    if (allowance < asset.amount) return { state: "missing-approval", balance, allowance };
    return { state: "backed", balance, allowance };
  }

  if (asset.kind === "ERC721") {
    const holder = await read(
      client.readContract({ address: asset.token, abi: erc721Abi, functionName: "ownerOf", args: [asset.tokenId] })
    );
    if (holder === undefined) return { state: "unknown" };
    if (holder.toLowerCase() !== owner.toLowerCase()) return { state: "not-held" };

    // ERC721Adapter.checkOwnership only checks ownerOf, but the transfer also
    // needs the adapter approved for this token or as an operator.
    const [approved, operator] = await Promise.all([
      read(client.readContract({ address: asset.token, abi: erc721Abi, functionName: "getApproved", args: [asset.tokenId] })),
      read(
        client.readContract({ address: asset.token, abi: erc721Abi, functionName: "isApprovedForAll", args: [owner, executor] })
      ),
    ]);
    const isApproved = approved?.toLowerCase() === executor.toLowerCase() || operator === true;
    return { state: isApproved ? "backed" : "missing-approval" };
  }

  if (asset.kind === "ENS") {
    const nodeOwner = await read(
      client.readContract({ address: asset.registry, abi: ensRegistryAbi, functionName: "owner", args: [asset.node] })
    );
    if (nodeOwner === undefined) return { state: "unknown" };
    if (nodeOwner.toLowerCase() !== owner.toLowerCase()) return { state: "not-held" };

    // The adapter calls registry.setOwner, which requires it to be an approved operator.
    const operator = await read(
      client.readContract({
        address: asset.registry,
        abi: ensRegistryAbi,
        functionName: "isApprovedForAll",
        args: [owner, executor],
      })
    );
    return { state: operator ? "backed" : "missing-approval" };
  }

  // Unknown executor: fall back to the adapter's own report.
  const held = await read(
    client.readContract({ address: executor, abi: executorAbi, functionName: "checkOwnership", args: [owner] })
  );
  if (held === undefined) return { state: "unknown" };
  return { state: held ? "backed" : "not-held" };
}

export async function checkAllocationsHealth(
  client: PublicClient,
  owner: Address,
  allocations: VaultAllocation[]
): Promise<AllocationHealthMap> {
  if (!owner || owner === ZERO_ADDRESS) return {};
  const entries = await Promise.all(
    allocations.map(async (a) => [a.assetId, await checkAllocationHealth(client, owner, a)] as const)
  );
  return Object.fromEntries(entries) as AllocationHealthMap;
}

export interface AllocationReadiness {
  /** Allocations still waiting to be claimed. */
  pending: number;
  /** Of those, how many would pay out in full right now. */
  backed: number;
  /** Of those, how many would pay out nothing (or less than allocated). */
  broken: number;
  /** Of those, how many could not be checked. */
  unknown: number;
}

export function summarizeReadiness(allocations: VaultAllocation[], health: AllocationHealthMap): AllocationReadiness {
  let pending = 0;
  let backed = 0;
  let broken = 0;
  let unknown = 0;
  for (const allocation of allocations) {
    if (allocation.executed) continue;
    pending++;
    const state = health[allocation.assetId]?.state;
    if (state === "backed") backed++;
    else if (state === undefined || state === "unknown") unknown++;
    else broken++;
  }
  return { pending, backed, broken, unknown };
}
