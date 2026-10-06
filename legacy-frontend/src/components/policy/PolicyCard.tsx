"use client";

import React from "react";
import { type Hex } from "viem";
import { type StructuredPolicy } from "@/lib/policy/types";

interface PolicyCardProps {
  activePolicy: StructuredPolicy | null;
  policyVersion: number;
  policyHash: Hex | null;
  onOpenBuilder: () => void;
  isOwner: boolean;
  vaultStatus: number;
}

export function PolicyCard({
  activePolicy,
  policyVersion,
  policyHash,
  onOpenBuilder,
  isOwner,
  vaultStatus,
}: PolicyCardProps) {
  const hasActivePolicy = policyVersion > 0 && policyHash && policyHash !== "0x0000000000000000000000000000000000000000000000000000000000000000";

  return (
    <div className="bg-[#1C2226] border border-[#2E353A] p-6 transition-all hover:border-[#3D474E]">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h3 className="font-['Fraunces'] text-xl text-[#EDEAE3]">Legacy Policy Engine</h3>
            {hasActivePolicy ? (
              <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium text-[#4CAF6D] bg-[#4CAF6D]/10 border border-[#4CAF6D]/30">
                Policy #{policyVersion} Active
              </span>
            ) : (
              <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium text-[#9A9E98] bg-[#252C31] border border-[#2E353A]">
                No Policy Committed
              </span>
            )}
          </div>
          <p className="text-sm text-[#9A9E98] mt-1 max-w-xl">
            Programmable inheritance rules. Express natural language intent, validate against chain state,
            simulate execution timelines, and cryptographically commit on-chain.
          </p>
        </div>

        {isOwner && (
          <button
            onClick={onOpenBuilder}
            className="self-start sm:self-center px-4 py-2 bg-[#B8894A] hover:bg-[#A5783D] text-[#10151A] text-sm font-medium transition-colors cursor-pointer shrink-0"
          >
            {hasActivePolicy ? "Modify Policy →" : "Design Policy →"}
          </button>
        )}
      </div>

      {hasActivePolicy ? (
        <div className="mt-5 pt-4 border-t border-[#2E353A] grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div>
            <span className="text-[#9A9E98] block mb-1">Cryptographic Hash</span>
            <span className="font-mono text-[#EDEAE3] break-all">{policyHash}</span>
          </div>
          <div>
            <span className="text-[#9A9E98] block mb-1">Commitment Authority</span>
            <span className="text-[#EDEAE3] block">
              {activePolicy && activePolicy.rules.length > 0
                ? `${activePolicy.rules.length} Rule${activePolicy.rules.length > 1 ? "s" : ""} Registered`
                : "Verified Vault Owner"}
            </span>
          </div>
          <div>
            <span className="text-[#9A9E98] block mb-1">On-Chain Enforcement</span>
            <span className="text-[#4CAF6D] flex items-center gap-1">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Cryptographically Locked
            </span>
          </div>
        </div>
      ) : (
        <div className="mt-4 pt-4 border-t border-[#2E353A] flex items-center justify-between text-xs text-[#9A9E98]">
          <span>Default behavior: Standard instant claim upon succession window expiry.</span>
          {vaultStatus !== 0 && (
            <span className="text-[#D99A3D]">Vault must be Green to configure policy</span>
          )}
        </div>
      )}
    </div>
  );
}
