export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export interface PolicyRule {
  beneficiary: Address;
  assetId: Hex;
  token: Address;
  amount: bigint;
  percentageBps: number; // 0 to 10000 (10000 = 100%)
  releaseDelaySeconds: bigint;
  fallbackBeneficiary: Address;
  beneficiaryName?: string;
  fallbackBeneficiaryName?: string;
  assetLabel?: string;
}

export interface StructuredPolicy {
  version: number;
  vault: Address;
  trigger: "TRIGGER_SUCCESSION";
  rules: PolicyRule[];
  policyHash?: Hex;
  committedAt?: number;
}

export interface PolicyValidationCheck {
  id: string;
  title: string;
  passed: boolean;
  level: "success" | "warning" | "error";
  detail: string;
}

export interface PolicyValidationResult {
  isValid: boolean;
  canCommit: boolean;
  checks: PolicyValidationCheck[];
  blockedReason?: string;
}

export interface PolicySimulationStep {
  id: string;
  timeOffsetSeconds: bigint;
  timeLabel: string;
  heir: Address;
  heirName: string;
  assetLabel: string;
  percentageLabel: string;
  amountLabel: string;
  executable: boolean;
  healthState: string;
  status: "EXECUTABLE" | "TIMELOCKED" | "BLOCKED";
  delayDescription: string;
}

export interface PolicySimulationResult {
  steps: PolicySimulationStep[];
  totalAllocatedBps: number;
  status: "READY" | "BLOCKED" | "TIMELOCKED";
  summary: string;
}

export interface VaultContextAsset {
  assetId: Hex;
  label: string;
  kind: "ERC20" | "ERC721" | "ENS" | "OTHER";
  token?: Address;
  amount?: bigint;
  symbol?: string;
  decimals?: number;
}

export interface VaultContextHeir {
  address: Address;
  name?: string;
}

export interface VaultPolicyContext {
  vaultAddress: Address;
  ownerAddress: Address;
  isOwnerConnected: boolean;
  vaultStatus: number; // 0 = Green, 1 = Amber, 2 = Red
  heirs: VaultContextHeir[];
  assets: VaultContextAsset[];
}

export interface IntentCompilationResult {
  success: boolean;
  policy?: StructuredPolicy;
  error?: string;
  suggestions?: string[];
  explanation?: string;
}
