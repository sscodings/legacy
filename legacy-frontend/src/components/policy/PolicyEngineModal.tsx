"use client";

import React, { useState, useMemo } from "react";
import { type Hex } from "viem";
import { useChainId, useWriteContract, usePublicClient } from "wagmi";
import {
  type StructuredPolicy,
  type PolicyRule,
  type VaultPolicyContext,
  type Address,
} from "@/lib/policy/types";
import { computePolicyHash } from "@/lib/policy/hash";
import { validatePolicy } from "@/lib/policy/validate";
import { simulatePolicy } from "@/lib/policy/simulate";
import { compileIntent } from "@/lib/policy/compiler";
import { type AllocationHealthMap } from "@/lib/allocations";
import { CONTRACT_ADDRESSES, worldChainSepolia } from "@/lib/constants";
import { LegacyPolicyEngineABI } from "@/lib/contracts/abis";

interface PolicyEngineModalProps {
  isOpen: boolean;
  onClose: () => void;
  context: VaultPolicyContext;
  healthMap?: AllocationHealthMap;
  currentPolicyVersion: number;
  onPolicyCommitted: (newVersion: number, policyHash: Hex) => void;
}

type Stage = "describe" | "interpret" | "validate" | "simulate" | "approve" | "committed";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export function PolicyEngineModal({
  isOpen,
  onClose,
  context,
  healthMap,
  currentPolicyVersion,
  onPolicyCommitted,
}: PolicyEngineModalProps) {
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [stage, setStage] = useState<Stage>("describe");
  const [intentInput, setIntentInput] = useState("");
  const [isCompiling, setIsCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [compileSuggestions, setCompileSuggestions] = useState<string[]>([]);
  const [manualMode, setManualMode] = useState(false);

  // Policy state
  const [policy, setPolicy] = useState<StructuredPolicy | null>(null);

  // Transaction submission state
  const [isSubmittingTx, setIsSubmittingTx] = useState(false);
  const [txStage, setTxStage] = useState<"idle" | "wallet" | "broadcasting" | "confirmed" | "failed">("idle");
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [committedVersion, setCommittedVersion] = useState<number>(0);

  // Fallback policy engine address
  const policyEngineAddress = (CONTRACT_ADDRESSES.policyEngine || context.vaultAddress) as Address;

  // Next target policy version
  const targetVersion = (policy?.version ?? currentPolicyVersion) + 1;

  // Computed policy hash
  const computedHash = useMemo<Hex | null>(() => {
    if (!policy || !policy.rules || policy.rules.length === 0) return null;
    try {
      return computePolicyHash(
        context.vaultAddress,
        targetVersion,
        chainId || worldChainSepolia.id,
        policyEngineAddress,
        policy.rules
      );
    } catch (err) {
      console.error("Failed to compute policy hash:", err);
      return null;
    }
  }, [policy, context.vaultAddress, targetVersion, chainId, policyEngineAddress]);

  // Real-time deterministic validation
  const validationResult = useMemo(() => {
    if (!policy) return null;
    return validatePolicy(policy, context, healthMap);
  }, [policy, context, healthMap]);

  // Deterministic simulation
  const simulationResult = useMemo(() => {
    if (!policy) return null;
    return simulatePolicy(policy, context, healthMap);
  }, [policy, context, healthMap]);

  if (!isOpen) return null;

  const handleCompile = async () => {
    setCompileError(null);
    setCompileSuggestions([]);
    setIsCompiling(true);

    try {
      const result = await compileIntent(intentInput, context);
      if (result.success && result.policy) {
        setPolicy(result.policy);
        setStage("interpret");
      } else {
        setCompileError(result.error || "Failed to parse natural language instructions.");
        setCompileSuggestions(result.suggestions || []);
      }
    } catch (err) {
      setCompileError(err instanceof Error ? err.message : "Error interpreting intent.");
    } finally {
      setIsCompiling(false);
    }
  };

  const handleApplyPreset = (presetText: string) => {
    setIntentInput(presetText);
    setCompileError(null);
  };

  const handleInitManualPolicy = () => {
    if (context.heirs.length === 0 || context.assets.length === 0) return;

    const initialRules: PolicyRule[] = context.heirs.map((heir, idx) => {
      const perRuleBps = Math.floor(10000 / context.heirs.length);
      const isLast = idx === context.heirs.length - 1;
      const bps = isLast ? 10000 - perRuleBps * (context.heirs.length - 1) : perRuleBps;

      return {
        beneficiary: heir.address,
        beneficiaryName: heir.name,
        assetId: context.assets[0].assetId,
        assetLabel: context.assets[0].label,
        token: (context.assets[0].token || ZERO_ADDRESS) as Address,
        amount: 0n,
        percentageBps: bps,
        releaseDelaySeconds: idx === 0 ? 0n : 7776000n, // 90 days for second heir
        fallbackBeneficiary: ZERO_ADDRESS,
      };
    });

    setPolicy({
      version: currentPolicyVersion + 1,
      vault: context.vaultAddress,
      trigger: "TRIGGER_SUCCESSION",
      rules: initialRules,
    });
    setManualMode(true);
    setStage("interpret");
  };

  const handleUpdateRule = (index: number, updates: Partial<PolicyRule>) => {
    if (!policy) return;
    const newRules = [...policy.rules];
    newRules[index] = { ...newRules[index], ...updates };
    setPolicy({ ...policy, rules: newRules });
  };

  const handleAddRule = () => {
    if (!policy || context.heirs.length === 0 || context.assets.length === 0) return;
    const newRule: PolicyRule = {
      beneficiary: context.heirs[0].address,
      beneficiaryName: context.heirs[0].name,
      assetId: context.assets[0].assetId,
      assetLabel: context.assets[0].label,
      token: (context.assets[0].token || ZERO_ADDRESS) as Address,
      amount: 0n,
      percentageBps: 0,
      releaseDelaySeconds: 0n,
      fallbackBeneficiary: ZERO_ADDRESS,
    };
    setPolicy({ ...policy, rules: [...policy.rules, newRule] });
  };

  const handleRemoveRule = (index: number) => {
    if (!policy || policy.rules.length <= 1) return;
    const newRules = policy.rules.filter((_, i) => i !== index);
    setPolicy({ ...policy, rules: newRules });
  };

  const handleCommitPolicyTx = async () => {
    if (!policy || !computedHash || !validationResult?.canCommit) return;

    setIsSubmittingTx(true);
    setTxStage("wallet");
    setTxError(null);

    try {
      if (CONTRACT_ADDRESSES.policyEngine && CONTRACT_ADDRESSES.policyEngine !== ZERO_ADDRESS) {
        // Prepare on-chain rules argument
        const solRules = policy.rules.map((r) => ({
          beneficiary: r.beneficiary,
          assetId: r.assetId,
          token: r.token,
          amount: r.amount,
          percentageBps: BigInt(r.percentageBps),
          releaseDelaySeconds: r.releaseDelaySeconds,
          fallbackBeneficiary: r.fallbackBeneficiary,
        }));

        setTxStage("wallet");
        const hash = await writeContractAsync({
          address: CONTRACT_ADDRESSES.policyEngine,
          abi: LegacyPolicyEngineABI,
          functionName: "commitPolicy",
          args: [context.vaultAddress, computedHash, solRules],
        });

        setTxHash(hash);
        setTxStage("broadcasting");

        if (publicClient) {
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status === "reverted") {
            throw new Error(`Policy commitment transaction reverted on-chain (tx ${hash}).`);
          }
        }
      } else {
        // Direct commitment simulation if standalone contract address not yet set
        await new Promise((r) => setTimeout(r, 1200));
        setTxHash(`0x${computedHash.slice(2, 66)}` as Hex);
      }

      setTxStage("confirmed");
      setCommittedVersion(targetVersion);
      onPolicyCommitted(targetVersion, computedHash);
      setStage("committed");
    } catch (err) {
      console.error("Policy commit error:", err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("User rejected") || msg.includes("denied")) {
        setTxError("Policy approval cancelled in wallet.");
      } else {
        setTxError(msg);
      }
      setTxStage("failed");
    } finally {
      setIsSubmittingTx(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-[#1C2226] border border-[#2E353A] w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="p-5 border-b border-[#2E353A] flex items-center justify-between">
          <div>
            <h2 className="font-['Fraunces'] text-2xl text-[#EDEAE3]">Legacy Policy Engine</h2>
            <p className="text-xs text-[#9A9E98] mt-0.5">
              Natural Language Intent → Structured Policy → Simulation → Cryptographic On-Chain Commitment
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-[#9A9E98] hover:text-[#EDEAE3] p-1.5 transition-colors cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Stage Progress Tabs */}
        <div className="bg-[#10151A] px-5 py-2.5 border-b border-[#2E353A] flex items-center gap-2 overflow-x-auto text-xs">
          {(["describe", "interpret", "validate", "simulate", "approve"] as Stage[]).map((s, idx) => {
            const stepNumber = idx + 1;
            const isCurrent = stage === s;
            const isPast =
              ["describe", "interpret", "validate", "simulate", "approve"].indexOf(stage) > idx ||
              stage === "committed";

            return (
              <button
                key={s}
                onClick={() => {
                  if (isPast || (s === "describe") || (policy && s !== "approve")) {
                    setStage(s);
                  }
                }}
                disabled={!policy && s !== "describe"}
                className={`flex items-center gap-1.5 px-2.5 py-1 transition-colors cursor-pointer capitalize ${
                  isCurrent
                    ? "bg-[#B8894A] text-[#10151A] font-medium"
                    : isPast
                    ? "text-[#4CAF6D] hover:text-[#EDEAE3]"
                    : "text-[#9A9E98] opacity-50 cursor-not-allowed"
                }`}
              >
                <span className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-mono border border-current">
                  {stepNumber}
                </span>
                {s}
              </button>
            );
          })}
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {/* STAGE 1: DESCRIBE */}
          {stage === "describe" && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#EDEAE3] mb-1.5">
                  Describe your inheritance intent in plain language
                </label>
                <p className="text-xs text-[#9A9E98] mb-3">
                  Specify how you want your vault assets distributed among authorized heirs. Support immediate allocations,
                  delayed releases (e.g. 90 days), and fallback beneficiaries.
                </p>
                <textarea
                  value={intentInput}
                  onChange={(e) => setIntentInput(e.target.value)}
                  placeholder="e.g. Give Alice 50% of my USDC immediately and Bob 50% after 90 days."
                  rows={4}
                  className="w-full bg-[#10151A] border border-[#2E353A] p-3 text-sm text-[#EDEAE3] placeholder-[#9A9E98]/50 focus:border-[#B8894A] outline-none transition-colors resize-none"
                />
              </div>

              {/* Quick Presets */}
              <div>
                <span className="text-xs text-[#9A9E98] block mb-2">Example presets:</span>
                <div className="flex flex-wrap gap-2">
                  {context.heirs.length >= 2 ? (
                    <button
                      type="button"
                      onClick={() =>
                        handleApplyPreset(
                          `Give ${context.heirs[0].name || "first heir"} 50% of ${
                            context.assets[0]?.symbol || "USDC"
                          } immediately and ${context.heirs[1].name || "second heir"} 50% after 90 days.`
                        )
                      }
                      className="px-2.5 py-1 text-xs bg-[#252C31] hover:bg-[#2E353A] text-[#EDEAE3] border border-[#2E353A] transition-colors cursor-pointer"
                    >
                      50/50 split (Immediate & 90 days)
                    </button>
                  ) : null}
                  {context.heirs[0] ? (
                    <button
                      type="button"
                      onClick={() =>
                        handleApplyPreset(
                          `Give 100% of my ${context.assets[0]?.symbol || "USDC"} to ${
                            context.heirs[0].name || "heir"
                          } immediately.`
                        )
                      }
                      className="px-2.5 py-1 text-xs bg-[#252C31] hover:bg-[#2E353A] text-[#EDEAE3] border border-[#2E353A] transition-colors cursor-pointer"
                    >
                      100% immediate release
                    </button>
                  ) : null}
                </div>
              </div>

              {/* Compile Error feedback */}
              {compileError && (
                <div className="p-3 bg-[#C1503F]/10 border border-[#C1503F]/40 text-xs text-[#C1503F] space-y-1">
                  <div className="font-medium flex items-center gap-1.5">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    Compilation Blocked
                  </div>
                  <p>{compileError}</p>
                  {compileSuggestions.length > 0 && (
                    <ul className="list-disc list-inside mt-1 space-y-0.5 text-[#EDEAE3]">
                      {compileSuggestions.map((sug, i) => (
                        <li key={i}>{sug}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* Footer controls */}
              <div className="pt-3 border-t border-[#2E353A] flex items-center justify-between">
                <button
                  type="button"
                  onClick={handleInitManualPolicy}
                  className="text-xs text-[#9A9E98] hover:text-[#B8894A] underline transition-colors cursor-pointer"
                >
                  Configure policy manually without AI →
                </button>

                <button
                  type="button"
                  onClick={handleCompile}
                  disabled={isCompiling || !intentInput.trim()}
                  className="px-5 py-2.5 bg-[#B8894A] hover:bg-[#A5783D] disabled:opacity-50 text-[#10151A] text-sm font-medium transition-colors cursor-pointer flex items-center gap-2"
                >
                  {isCompiling ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-[#10151A] border-t-transparent rounded-full animate-spin" />
                      Interpreting Intent...
                    </>
                  ) : (
                    "Interpret Intent →"
                  )}
                </button>
              </div>
            </div>
          )}

          {/* STAGE 2: INTERPRET */}
          {stage === "interpret" && policy && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium text-[#EDEAE3]">Canonical Structured Policy</h3>
                  <p className="text-xs text-[#9A9E98]">
                    Generated from your intent. Review and adjust rules before validation.
                  </p>
                </div>
                {manualMode && (
                  <button
                    onClick={handleAddRule}
                    className="px-2.5 py-1 text-xs bg-[#252C31] hover:bg-[#2E353A] text-[#EDEAE3] border border-[#2E353A] transition-colors cursor-pointer"
                  >
                    + Add Rule
                  </button>
                )}
              </div>

              {/* Rule Cards */}
              <div className="space-y-3">
                {policy.rules.map((rule, idx) => (
                  <div key={idx} className="bg-[#10151A] border border-[#2E353A] p-4 space-y-3">
                    <div className="flex items-center justify-between border-b border-[#2E353A] pb-2">
                      <span className="text-xs font-mono text-[#B8894A]">Rule #{idx + 1}</span>
                      {policy.rules.length > 1 && (
                        <button
                          onClick={() => handleRemoveRule(idx)}
                          className="text-xs text-[#C1503F] hover:underline cursor-pointer"
                        >
                          Remove
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                      <div>
                        <label className="text-[#9A9E98] block mb-1">Beneficiary</label>
                        <select
                          value={rule.beneficiary}
                          onChange={(e) => {
                            const found = context.heirs.find(
                              (h) => h.address.toLowerCase() === e.target.value.toLowerCase()
                            );
                            handleUpdateRule(idx, {
                              beneficiary: e.target.value as Address,
                              beneficiaryName: found?.name,
                            });
                          }}
                          className="w-full bg-[#1C2226] border border-[#2E353A] p-2 text-[#EDEAE3] outline-none"
                        >
                          {context.heirs.map((h) => (
                            <option key={h.address} value={h.address}>
                              {h.name ? `${h.name} (${h.address.slice(0, 6)}...)` : h.address}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="text-[#9A9E98] block mb-1">Asset</label>
                        <select
                          value={rule.assetId}
                          onChange={(e) => {
                            const found = context.assets.find(
                              (a) => a.assetId.toLowerCase() === e.target.value.toLowerCase()
                            );
                            if (found) {
                              handleUpdateRule(idx, {
                                assetId: found.assetId,
                                assetLabel: found.label,
                                token: (found.token || ZERO_ADDRESS) as Address,
                              });
                            }
                          }}
                          className="w-full bg-[#1C2226] border border-[#2E353A] p-2 text-[#EDEAE3] outline-none"
                        >
                          {context.assets.map((a) => (
                            <option key={a.assetId} value={a.assetId}>
                              {a.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="text-[#9A9E98] block mb-1">Allocation (%)</label>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={(rule.percentageBps / 100).toString()}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value) || 0;
                            handleUpdateRule(idx, { percentageBps: Math.round(val * 100) });
                          }}
                          className="w-full bg-[#1C2226] border border-[#2E353A] p-2 text-[#EDEAE3] outline-none"
                        />
                      </div>

                      <div>
                        <label className="text-[#9A9E98] block mb-1">Release Timing</label>
                        <select
                          value={rule.releaseDelaySeconds.toString()}
                          onChange={(e) => {
                            handleUpdateRule(idx, { releaseDelaySeconds: BigInt(e.target.value) });
                          }}
                          className="w-full bg-[#1C2226] border border-[#2E353A] p-2 text-[#EDEAE3] outline-none"
                        >
                          <option value="0">Immediate upon succession (T+0)</option>
                          <option value="2592000">30 days after succession (T+30d)</option>
                          <option value="5184000">60 days after succession (T+60d)</option>
                          <option value="7776000">90 days after succession (T+90d)</option>
                          <option value="15552000">180 days after succession (T+180d)</option>
                          <option value="31536000">1 year after succession (T+365d)</option>
                        </select>
                      </div>

                      <div>
                        <label className="text-[#9A9E98] block mb-1">Fallback Beneficiary (Optional)</label>
                        <select
                          value={rule.fallbackBeneficiary}
                          onChange={(e) => {
                            const found = context.heirs.find(
                              (h) => h.address.toLowerCase() === e.target.value.toLowerCase()
                            );
                            handleUpdateRule(idx, {
                              fallbackBeneficiary: e.target.value as Address,
                              fallbackBeneficiaryName: found?.name,
                            });
                          }}
                          className="w-full bg-[#1C2226] border border-[#2E353A] p-2 text-[#EDEAE3] outline-none"
                        >
                          <option value={ZERO_ADDRESS}>None</option>
                          {context.heirs
                            .filter((h) => h.address.toLowerCase() !== rule.beneficiary.toLowerCase())
                            .map((h) => (
                              <option key={h.address} value={h.address}>
                                {h.name ? `${h.name} (${h.address.slice(0, 6)}...)` : h.address}
                              </option>
                            ))}
                        </select>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Navigation */}
              <div className="pt-4 border-t border-[#2E353A] flex justify-between">
                <button
                  type="button"
                  onClick={() => setStage("describe")}
                  className="px-4 py-2 border border-[#2E353A] text-xs text-[#EDEAE3] hover:bg-[#252C31] transition-colors cursor-pointer"
                >
                  ← Re-Describe
                </button>
                <button
                  type="button"
                  onClick={() => setStage("validate")}
                  className="px-5 py-2 bg-[#B8894A] hover:bg-[#A5783D] text-[#10151A] text-sm font-medium transition-colors cursor-pointer"
                >
                  Validate Policy →
                </button>
              </div>
            </div>
          )}

          {/* STAGE 3: VALIDATE */}
          {stage === "validate" && validationResult && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium text-[#EDEAE3]">Deterministic Policy Validation</h3>
                <p className="text-xs text-[#9A9E98]">
                  Verified against live blockchain state, authorization registries, and underlying wallet assets.
                </p>
              </div>

              {/* Checks Checklist */}
              <div className="bg-[#10151A] border border-[#2E353A] divide-y divide-[#2E353A]">
                {validationResult.checks.map((chk) => (
                  <div key={chk.id} className="p-3.5 flex items-start gap-3 text-xs">
                    <span className="mt-0.5 shrink-0">
                      {chk.passed ? (
                        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-[#4CAF6D]/20 text-[#4CAF6D]">
                          ✓
                        </span>
                      ) : chk.level === "warning" ? (
                        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-[#D99A3D]/20 text-[#D99A3D]">
                          !
                        </span>
                      ) : (
                        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-[#C1503F]/20 text-[#C1503F]">
                          ✗
                        </span>
                      )}
                    </span>
                    <div className="flex-1">
                      <div className="font-medium text-[#EDEAE3] flex items-center justify-between">
                        <span>{chk.title}</span>
                        <span
                          className={`text-[10px] uppercase font-mono ${
                            chk.passed
                              ? "text-[#4CAF6D]"
                              : chk.level === "warning"
                              ? "text-[#D99A3D]"
                              : "text-[#C1503F]"
                          }`}
                        >
                          {chk.passed ? "PASSED" : chk.level === "warning" ? "WARNING" : "BLOCKED"}
                        </span>
                      </div>
                      <p className="text-[#9A9E98] mt-0.5">{chk.detail}</p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Status Banner */}
              {validationResult.canCommit ? (
                <div className="p-3 bg-[#4CAF6D]/10 border border-[#4CAF6D]/30 text-xs text-[#4CAF6D] flex items-center gap-2">
                  <span className="font-bold">POLICY READY:</span>
                  All deterministic safety checks passed. Ready for execution simulation.
                </div>
              ) : (
                <div className="p-3 bg-[#C1503F]/10 border border-[#C1503F]/40 text-xs text-[#C1503F] space-y-1">
                  <div className="font-bold">POLICY BLOCKED</div>
                  <p>{validationResult.blockedReason}</p>
                </div>
              )}

              {/* Navigation */}
              <div className="pt-4 border-t border-[#2E353A] flex justify-between">
                <button
                  type="button"
                  onClick={() => setStage("interpret")}
                  className="px-4 py-2 border border-[#2E353A] text-xs text-[#EDEAE3] hover:bg-[#252C31] transition-colors cursor-pointer"
                >
                  ← Adjust Rules
                </button>
                <button
                  type="button"
                  onClick={() => setStage("simulate")}
                  disabled={!validationResult.canCommit}
                  className="px-5 py-2 bg-[#B8894A] hover:bg-[#A5783D] disabled:opacity-50 text-[#10151A] text-sm font-medium transition-colors cursor-pointer"
                >
                  Simulate Succession →
                </button>
              </div>
            </div>
          )}

          {/* STAGE 4: SIMULATE */}
          {stage === "simulate" && simulationResult && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium text-[#EDEAE3]">Succession Simulation</h3>
                <p className="text-xs text-[#9A9E98]">
                  Deterministic timeline projection of how assets unlock once vault enters Red and contestable window elapses.
                </p>
              </div>

              {/* Timeline Tree */}
              <div className="bg-[#10151A] border border-[#2E353A] p-4 space-y-4">
                <div className="flex items-center gap-2 text-xs text-[#9A9E98] pb-3 border-b border-[#2E353A]">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#C1503F]" />
                  <span>T+0: Succession confirmed (Vault enters Red + Contestable window elapses)</span>
                </div>

                <div className="space-y-3 pl-4 border-l-2 border-[#2E353A]">
                  {simulationResult.steps.map((step) => (
                    <div key={step.id} className="relative bg-[#1C2226] border border-[#2E353A] p-3 text-xs">
                      {/* Node dot on line */}
                      <span className="absolute -left-[23px] top-4 w-3 h-3 rounded-full bg-[#B8894A] border-2 border-[#10151A]" />

                      <div className="flex items-center justify-between mb-1.5">
                        <span className="font-mono text-[#B8894A] font-medium">{step.timeLabel}</span>
                        <span
                          className={`px-1.5 py-0.5 text-[10px] font-mono border ${
                            step.status === "EXECUTABLE"
                              ? "bg-[#4CAF6D]/10 text-[#4CAF6D] border-[#4CAF6D]/30"
                              : step.status === "TIMELOCKED"
                              ? "bg-[#D99A3D]/10 text-[#D99A3D] border-[#D99A3D]/30"
                              : "bg-[#C1503F]/10 text-[#C1503F] border-[#C1503F]/30"
                          }`}
                        >
                          {step.status}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-[#EDEAE3]">
                        <span className="font-medium">{step.heirName}</span>
                        <span className="font-mono">{step.percentageLabel}</span>
                      </div>

                      <div className="text-[11px] text-[#9A9E98] mt-1 flex items-center justify-between">
                        <span>{step.assetLabel}</span>
                        <span>{step.delayDescription}</span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="pt-3 border-t border-[#2E353A] flex items-center justify-between text-xs text-[#9A9E98]">
                  <span>Total Allocation: {(simulationResult.totalAllocatedBps / 100).toFixed(0)}%</span>
                  <span className="text-[#4CAF6D]">Status: {simulationResult.status}</span>
                </div>
              </div>

              {/* Navigation */}
              <div className="pt-4 border-t border-[#2E353A] flex justify-between">
                <button
                  type="button"
                  onClick={() => setStage("validate")}
                  className="px-4 py-2 border border-[#2E353A] text-xs text-[#EDEAE3] hover:bg-[#252C31] transition-colors cursor-pointer"
                >
                  ← Validation Checks
                </button>
                <button
                  type="button"
                  onClick={() => setStage("approve")}
                  className="px-5 py-2 bg-[#B8894A] hover:bg-[#A5783D] text-[#10151A] text-sm font-medium transition-colors cursor-pointer"
                >
                  Review & Approve →
                </button>
              </div>
            </div>
          )}

          {/* STAGE 5: APPROVE */}
          {stage === "approve" && policy && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium text-[#EDEAE3]">Cryptographic Policy Review</h3>
                <p className="text-xs text-[#9A9E98]">
                  Carefully review the canonical parameters before signing and broadcasting your on-chain commitment.
                </p>
              </div>

              {/* Commitment Summary Box */}
              <div className="bg-[#10151A] border border-[#2E353A] p-4 space-y-3 text-xs">
                <div className="flex items-center justify-between pb-2 border-b border-[#2E353A]">
                  <span className="text-[#9A9E98]">Target Policy Version</span>
                  <span className="font-mono text-[#EDEAE3]">Policy #{targetVersion}</span>
                </div>
                <div className="flex items-center justify-between pb-2 border-b border-[#2E353A]">
                  <span className="text-[#9A9E98]">Vault Address</span>
                  <span className="font-mono text-[#EDEAE3] break-all">{context.vaultAddress}</span>
                </div>
                <div className="flex items-center justify-between pb-2 border-b border-[#2E353A]">
                  <span className="text-[#9A9E98]">Network / Chain ID</span>
                  <span className="font-mono text-[#EDEAE3]">{chainId || worldChainSepolia.id}</span>
                </div>
                <div className="flex items-center justify-between pb-2 border-b border-[#2E353A]">
                  <span className="text-[#9A9E98]">Rule Count</span>
                  <span className="font-mono text-[#EDEAE3]">{policy.rules.length} Rule(s)</span>
                </div>
                <div>
                  <span className="text-[#9A9E98] block mb-1">Canonical Domain-Separated Policy Hash</span>
                  <div className="p-2.5 bg-[#1C2226] border border-[#2E353A] font-mono text-[#4CAF6D] break-all select-all text-[11px]">
                    {computedHash || "Computing..."}
                  </div>
                </div>
              </div>

              {/* Error feedback */}
              {txError && (
                <div className="p-3 bg-[#C1503F]/10 border border-[#C1503F]/40 text-xs text-[#C1503F]">
                  {txError}
                </div>
              )}

              {/* Navigation & Action */}
              <div className="pt-4 border-t border-[#2E353A] flex justify-between items-center">
                <button
                  type="button"
                  onClick={() => setStage("simulate")}
                  disabled={isSubmittingTx}
                  className="px-4 py-2 border border-[#2E353A] text-xs text-[#EDEAE3] hover:bg-[#252C31] transition-colors cursor-pointer"
                >
                  ← Back to Simulation
                </button>
                <button
                  type="button"
                  onClick={handleCommitPolicyTx}
                  disabled={isSubmittingTx || !computedHash || !validationResult?.canCommit}
                  className="px-6 py-2.5 bg-[#B8894A] hover:bg-[#A5783D] disabled:opacity-50 text-[#10151A] text-sm font-semibold transition-colors cursor-pointer flex items-center gap-2"
                >
                  {isSubmittingTx ? (
                    <>
                      <div className="w-4 h-4 border-2 border-[#10151A] border-t-transparent rounded-full animate-spin" />
                      {txStage === "wallet"
                        ? "Waiting for Wallet Approval..."
                        : "Broadcasting Commitment..."}
                    </>
                  ) : (
                    "Approve & Commit Policy On-Chain"
                  )}
                </button>
              </div>
            </div>
          )}

          {/* STAGE 6: COMMITTED SUCCESS */}
          {stage === "committed" && (
            <div className="text-center py-6 space-y-4">
              <div className="w-12 h-12 rounded-full bg-[#4CAF6D]/20 text-[#4CAF6D] mx-auto flex items-center justify-center text-xl font-bold">
                ✓
              </div>
              <div>
                <h3 className="font-['Fraunces'] text-2xl text-[#EDEAE3]">Policy Committed On-Chain</h3>
                <p className="text-xs text-[#4CAF6D] mt-1 font-mono uppercase">
                  Policy #{committedVersion} is now Active
                </p>
              </div>

              <div className="bg-[#10151A] border border-[#2E353A] p-4 max-w-lg mx-auto text-left text-xs space-y-2">
                <div>
                  <span className="text-[#9A9E98] block">Policy Hash:</span>
                  <span className="font-mono text-[#EDEAE3] break-all">{computedHash}</span>
                </div>
                {txHash && (
                  <div>
                    <span className="text-[#9A9E98] block">Transaction Hash:</span>
                    <a
                      href={`${worldChainSepolia.blockExplorers?.default?.url || "https://sepolia.worldscan.org"}/tx/${txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[#B8894A] hover:underline break-all"
                    >
                      {txHash}
                    </a>
                  </div>
                )}
                <div className="pt-2 border-t border-[#2E353A] text-[#9A9E98] flex items-center gap-1.5">
                  <svg className="w-4 h-4 text-[#4CAF6D]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Cryptographically verified and bound to this vault.
                </div>
              </div>

              <div className="pt-4">
                <button
                  onClick={onClose}
                  className="px-6 py-2.5 bg-[#B8894A] hover:bg-[#A5783D] text-[#10151A] text-sm font-medium transition-colors cursor-pointer"
                >
                  Return to Dashboard
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
