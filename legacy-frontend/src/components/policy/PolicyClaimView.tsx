"use client";

import React from "react";
import { type Hex } from "viem";
import { type PolicyRule } from "@/lib/policy/types";
import { formatDelayLabel } from "@/lib/policy/simulate";

interface PolicyClaimViewProps {
  policyVersion: number;
  policyHash: Hex | null;
  rules: PolicyRule[];
  claimantAddress: `0x${string}`;
}

export function PolicyClaimView({
  policyVersion,
  policyHash,
  rules,
  claimantAddress,
}: PolicyClaimViewProps) {
  if (policyVersion === 0 || !policyHash) return null;

  const claimantRules = rules.filter(
    (r) =>
      r.beneficiary.toLowerCase() === claimantAddress.toLowerCase() ||
      r.fallbackBeneficiary.toLowerCase() === claimantAddress.toLowerCase()
  );

  return (
    <div className="bg-[#1C2226] border border-[#2E353A] p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs uppercase font-mono text-[#B8894A] block">Policy-Governed Succession</span>
          <h3 className="font-['Fraunces'] text-lg text-[#EDEAE3]">Inheritance Distribution Schedule</h3>
        </div>
        <span className="text-xs font-mono px-2 py-0.5 bg-[#252C31] text-[#9A9E98] border border-[#2E353A]">
          Policy #{policyVersion}
        </span>
      </div>

      {claimantRules.length > 0 ? (
        <div className="space-y-2.5">
          {claimantRules.map((rule, idx) => {
            const isFallback = rule.fallbackBeneficiary.toLowerCase() === claimantAddress.toLowerCase();
            const { label: delayLabel } = formatDelayLabel(rule.releaseDelaySeconds);
            const isImmediate = rule.releaseDelaySeconds === 0n;

            return (
              <div key={idx} className="bg-[#10151A] border border-[#2E353A] p-3 text-xs space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-[#EDEAE3]">
                    {rule.assetLabel || "Allocated Asset"}
                    {isFallback && <span className="text-[#D99A3D] ml-1">(Designated as Fallback)</span>}
                  </span>
                  <span className="font-mono text-[#B8894A]">
                    {rule.percentageBps > 0 ? `${(rule.percentageBps / 100).toFixed(0)}%` : "Fixed allocation"}
                  </span>
                </div>

                <div className="flex items-center justify-between text-[#9A9E98] pt-1 border-t border-[#2E353A]">
                  <span>Release Timing:</span>
                  <span className={isImmediate ? "text-[#4CAF6D]" : "text-[#D99A3D]"}>
                    {delayLabel}
                  </span>
                </div>

                <div className="text-[11px] text-[#9A9E98]/80">
                  {isImmediate ? (
                    <span>✓ On-chain release unlocks immediately once succession contestable window elapses.</span>
                  ) : (
                    <span>⏳ Timelocked by Policy Adapter. Claim cannot be executed until release delay elapses.</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-xs text-[#9A9E98] bg-[#10151A] p-3 border border-[#2E353A]">
          This vault is bound to Policy #{policyVersion}. No specific custom delay rule was found for your address; standard succession rules apply.
        </div>
      )}

      <div className="text-[11px] text-[#9A9E98] pt-2 border-t border-[#2E353A] flex items-center justify-between">
        <span>Policy Hash:</span>
        <span className="font-mono text-[#EDEAE3] truncate max-w-xs">{policyHash}</span>
      </div>
    </div>
  );
}
