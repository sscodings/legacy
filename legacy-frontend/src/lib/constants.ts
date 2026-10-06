import { type Chain } from "viem";

export const worldChainSepolia: Chain = {
  id: 4801,
  name: "World Chain Sepolia",
  nativeCurrency: {
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [
        process.env.NEXT_PUBLIC_WORLD_CHAIN_RPC_URL ||
          "https://worldchain-sepolia.gateway.tenderly.co",
      ],
    },
    public: {
      http: [
        "https://worldchain-sepolia.gateway.tenderly.co",
        "https://worldchain-sepolia.g.alchemy.com/public",
      ],
    },
  },
  blockExplorers: {
    default: {
      name: "Worldscan",
      url: "https://sepolia.worldscan.org",
    },
  },
  testnet: true,
};

export const CONTRACT_ADDRESSES = {
  factory: (process.env.NEXT_PUBLIC_FACTORY_ADDRESS || "") as `0x${string}`,
  verifier: (process.env.NEXT_PUBLIC_VERIFIER_ADDRESS || "") as `0x${string}`,
  implementation: (process.env.NEXT_PUBLIC_IMPLEMENTATION_ADDRESS || "") as `0x${string}`,
  smokeVault: (process.env.NEXT_PUBLIC_SMOKE_VAULT_ADDRESS || "") as `0x${string}`,
  policyEngine: (process.env.NEXT_PUBLIC_POLICY_ENGINE_ADDRESS || "") as `0x${string}`,
};

export const WORLD_ID_CONFIG = {
  appId: (process.env.NEXT_PUBLIC_WORLD_ID_APP_ID || "") as `app_${string}`,
  rpId: (process.env.NEXT_PUBLIC_WORLD_ID_RP_ID || "") as `rp_${string}`,
  action: process.env.NEXT_PUBLIC_WORLD_ID_ACTION || "heartbeat",
  groupId: Number(process.env.NEXT_PUBLIC_WORLD_ID_GROUP_ID || 1), // 1 = Orb-verified
};

export const PROTOCOL_FLOORS = {
  minCheckInIntervalSeconds: 5, // 5s floor for rapid testing
  minContestableWindowSeconds: 5, // 5s floor for rapid testing
};

export enum VaultStatus {
  Green = 0,
  Amber = 1,
  Red = 2,
}

/** Plain-language status copy, so users don't have to decode GREEN / AMBER / RED. */
export const VAULT_STATUS_COPY: Record<VaultStatus, { label: string; color: string }> = {
  [VaultStatus.Green]: { label: "Active", color: "var(--status-green)" },
  [VaultStatus.Amber]: { label: "Check-in overdue", color: "var(--status-amber)" },
  [VaultStatus.Red]: { label: "Claims open", color: "var(--status-red)" },
};

/** Short, human fallback for an unnamed address: 0x1234…abcd */
export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const DURATION_UNITS: [number, string][] = [
  [86400, "day"],
  [3600, "hour"],
  [60, "minute"],
  [1, "second"],
];

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/**
 * Largest unit plus the next one down when there's a remainder:
 * 45 → "45 seconds", 615 → "10 minutes 15 seconds", 2592000 → "30 days".
 */
export function humanDuration(seconds: number, maxUnits: 1 | 2 = 2): string {
  const s = Math.max(0, Math.floor(seconds));
  for (let i = 0; i < DURATION_UNITS.length; i++) {
    const [size, unit] = DURATION_UNITS[i];
    if (s >= size || size === 1) {
      const n = Math.floor(s / size);
      const next = DURATION_UNITS[i + 1];
      const rest = next && maxUnits > 1 ? Math.floor((s % size) / next[0]) : 0;
      return rest > 0 ? `${plural(n, unit)} ${plural(rest, next[1])}` : plural(n, unit);
    }
  }
  return "0 seconds";
}

/** "3 days ago" for a unix timestamp in seconds. */
export function timeAgo(unixSeconds: number): string {
  const elapsed = Date.now() / 1000 - unixSeconds;
  return elapsed < 5 ? "just now" : `${humanDuration(elapsed, 1)} ago`;
}

export enum ClaimStatus {
  NotInitiated = 0,
  Contestable = 1,
  Claimed = 2,
}

export interface KnownToken {
  name: string;
  symbol: string;
  decimals: number;
  address?: `0x${string}`; // undefined for Native ETH
  isNative?: boolean;
}

export const KNOWN_TESTNET_TOKENS: KnownToken[] = [
  {
    name: "Native Ether",
    symbol: "ETH",
    decimals: 18,
    isNative: true,
  },
  {
    name: "USD Coin (Circle)",
    symbol: "USDC",
    decimals: 6,
    address: "0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88",
  },
];
