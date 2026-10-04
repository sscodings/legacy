export type AlertThreshold =
  | "7d"
  | "3d"
  | "24h"
  | "amber"
  | "claim_initiated"
  | "claim_expiring_24h"
  | "claim_expired"
  | "vault_created"
  | "test"
  | "underfunded";

export type NotificationChannel = "email" | "push";

export interface AlertLogEntry {
  id: string;
  threshold: AlertThreshold;
  title: string;
  message: string;
  timestamp: number;
  channel: NotificationChannel | "all";
  success: boolean;
  error?: string;
}

export interface VaultNotificationSubscription {
  vaultAddress: `0x${string}`;
  ownerAddress: `0x${string}`;
  email?: string;
  emailVerified?: boolean;
  pushEnabled?: boolean;
  createdAt: number;
  updatedAt: number;
  lastAlertSent?: {
    threshold: AlertThreshold;
    timestamp: number;
    cycleEpoch: number; // correlates with contract lastCheckIn
  };
  lastClaimAlertSent?: {
    threshold: AlertThreshold;
    timestamp: number;
    claimInitiatedAt: number;
    heirAddress: `0x${string}`;
  };
  lastFundingAlert?: {
    fingerprint: string;
    timestamp: number;
  };
  recentAlerts?: AlertLogEntry[];
}

export interface SubscribeRequest {
  vaultAddress: `0x${string}`;
  ownerAddress: `0x${string}`;
  email?: string;
  pushEnabled?: boolean;
}

export interface SendTestAlertRequest {
  vaultAddress: `0x${string}`;
  channel?: NotificationChannel | "all";
}

export interface ClaimAlertRequest {
  vaultAddress: `0x${string}`;
  heirAddress: `0x${string}`;
  txHash?: `0x${string}`;
}
