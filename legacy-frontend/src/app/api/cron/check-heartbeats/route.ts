import { NextResponse } from "next/server";
import { createPublicClient, http, isAddress } from "viem";
import { worldChainSepolia, shortAddress } from "@/lib/constants";
import { LegacyVaultABI } from "@/lib/contracts/abis";
import {
  getAllSubscriptions,
  updateLastAlert,
  updateLastClaimAlert,
  updateLastFundingAlert,
} from "@/lib/notifications/store";
import {
  dispatchHeartbeatAlert,
  dispatchClaimAlert,
  dispatchClaimExpiringAlert,
  dispatchClaimExpiredAlert,
  dispatchTestAlert,
  dispatchUnderfundedAlert,
} from "@/lib/notifications/dispatcher";
import { getServerPublicClient } from "@/lib/inheritance/chain";
import {
  loadVaultAllocations,
  assessAllocations,
  getHealthReasonMessage,
} from "@/lib/health/allocation-health";
import { AlertThreshold, VaultNotificationSubscription } from "@/types/notifications";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleHeartbeatCheck(request);
}

export async function POST(request: Request) {
  return handleHeartbeatCheck(request);
}

async function handleHeartbeatCheck(request: Request) {
  try {
    const url = new URL(request.url);
    const cronSecret = process.env.CRON_SECRET?.trim();

    let bodyData: Record<string, any> = {};
    if (request.method === "POST") {
      try {
        bodyData = await request.json();
      } catch {
        // empty body or non-JSON
      }
    }

    // Extract parameters from URL search params or POST body
    const paramEmail =
      bodyData.email ||
      bodyData.ownerEmail ||
      url.searchParams.get("email") ||
      url.searchParams.get("ownerEmail");

    const paramVault =
      bodyData.vaultAddress ||
      bodyData.vault ||
      url.searchParams.get("vaultAddress") ||
      url.searchParams.get("vault");

    const paramThreshold =
      bodyData.threshold ||
      bodyData.type ||
      url.searchParams.get("threshold") ||
      url.searchParams.get("type");

    const paramHeir =
      bodyData.heirAddress ||
      bodyData.heir ||
      url.searchParams.get("heirAddress") ||
      url.searchParams.get("heir");

    const paramSeconds =
      bodyData.secondsRemaining !== undefined
        ? Number(bodyData.secondsRemaining)
        : url.searchParams.get("secondsRemaining")
        ? Number(url.searchParams.get("secondsRemaining"))
        : undefined;


    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL || "https://legacy-drab-two.vercel.app";

    const paramPush =
      bodyData.pushEnabled !== undefined
        ? Boolean(bodyData.pushEnabled)
        : url.searchParams.get("pushEnabled") === "true";

    // ─────────────────────────────────────────────────────────────────────────────
    // Direct Param Mode: Allows manual or programmatic dispatch by passing params
    // ─────────────────────────────────────────────────────────────────────────────
    if (paramEmail) {
      const vaultStr = paramVault || "0x0000000000000000000000000000000000000000";
      const validVault = isAddress(vaultStr)
        ? (vaultStr as `0x${string}`)
        : ("0x0000000000000000000000000000000000000000" as `0x${string}`);

      const sub: VaultNotificationSubscription = {
        vaultAddress: validVault,
        ownerAddress: validVault,
        email: paramEmail.trim().toLowerCase(),
        emailVerified: true,
        pushEnabled: paramPush,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const heirStr = paramHeir || "0x1111111111111111111111111111111111111111";
      const validHeir = isAddress(heirStr)
        ? (heirStr as `0x${string}`)
        : ("0x1111111111111111111111111111111111111111" as `0x${string}`);

      const seconds = paramSeconds !== undefined ? paramSeconds : 86400; // default 24h
      let dispatchRes: { success: boolean; channelsNotified: string[]; error?: string };

      if (paramThreshold === "claim_initiated" || paramThreshold === "claim_started") {
        dispatchRes = await dispatchClaimAlert(sub, validHeir, seconds, undefined, baseUrl);
      } else if (paramThreshold === "claim_expiring_24h" || paramThreshold === "claim_expiring") {
        dispatchRes = await dispatchClaimExpiringAlert(sub, validHeir, seconds, baseUrl);
      } else if (paramThreshold === "claim_expired") {
        dispatchRes = await dispatchClaimExpiredAlert(sub, validHeir, baseUrl);
      } else if (paramThreshold === "test") {
        dispatchRes = await dispatchTestAlert(sub, "email", baseUrl);
      } else {
        const threshold: AlertThreshold =
          (paramThreshold as AlertThreshold) || (seconds <= 86400 ? "24h" : "7d");
        dispatchRes = await dispatchHeartbeatAlert(sub, threshold, seconds, baseUrl);
      }

      return NextResponse.json({
        success: dispatchRes.success,
        mode: "direct_param_dispatch",
        recipient: paramEmail,
        vaultAddress: vaultStr,
        threshold: paramThreshold || "heartbeat",
        secondsRemaining: seconds,
        channelsNotified: dispatchRes.channelsNotified,
        error: dispatchRes.error,
        baseUrl,
      });
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Scheduled Cron Mode: Loop through all active vault subscriptions
    // ─────────────────────────────────────────────────────────────────────────────
    const subscriptions = await getAllSubscriptions();
    if (subscriptions.length === 0) {
      return NextResponse.json({
        success: true,
        processed: 0,
        message: "No active vault subscriptions found to evaluate.",
      });
    }

    const publicClient = createPublicClient({
      chain: worldChainSepolia,
      transport: http(
        process.env.NEXT_PUBLIC_WORLD_CHAIN_RPC_URL ||
          "https://worldchain-sepolia.gateway.tenderly.co"
      ),
    });

    const now = Math.floor(Date.now() / 1000);
    const results = [];
    let alertsDispatched = 0;

    for (const sub of subscriptions) {
      try {
        if (!isAddress(sub.vaultAddress)) {
          results.push({
            vault: sub.vaultAddress,
            skipped: true,
            reason: "Non-EVM address format",
          });
          continue;
        }

        const [lastCheckInRaw, checkInIntervalRaw, statusRaw] = await Promise.all([
          publicClient.readContract({
            address: sub.vaultAddress,
            abi: LegacyVaultABI,
            functionName: "lastCheckIn",
          }),
          publicClient.readContract({
            address: sub.vaultAddress,
            abi: LegacyVaultABI,
            functionName: "checkInInterval",
          }),
          publicClient.readContract({
            address: sub.vaultAddress,
            abi: LegacyVaultABI,
            functionName: "getStatus",
          }),
        ]);

        const lastCheckIn = Number(lastCheckInRaw);
        const checkInInterval = Number(checkInIntervalRaw);
        const status = Number(statusRaw);

        const amberDeadline = lastCheckIn + checkInInterval;
        const secondsRemaining = amberDeadline - now;
        const lastCycle = sub.lastAlertSent?.cycleEpoch;
        const isNewCycle = lastCycle !== lastCheckIn;

        let neededThreshold: AlertThreshold | null = null;

        // Long interval (>= 1 day)
        if (checkInInterval >= 86400) {
          if (status === 0 /* Green */ && secondsRemaining > 0) {
            if (secondsRemaining <= 86400) {
              if (isNewCycle || sub.lastAlertSent?.threshold !== "24h") {
                neededThreshold = "24h";
              }
            } else if (secondsRemaining <= 259200) {
              if (isNewCycle || !["24h", "3d"].includes(sub.lastAlertSent?.threshold || "")) {
                neededThreshold = "3d";
              }
            } else if (secondsRemaining <= 604800) {
              if (isNewCycle || !["24h", "3d", "7d"].includes(sub.lastAlertSent?.threshold || "")) {
                neededThreshold = "7d";
              }
            }
          } else if (status === 1 /* Amber */) {
            if (isNewCycle || sub.lastAlertSent?.threshold !== "amber") {
              neededThreshold = "amber";
            }
          }
        } else {
          // Rapid demo interval (< 1 day)
          if (status === 0 /* Green */ && secondsRemaining > 0) {
            const fraction = secondsRemaining / checkInInterval;
            if (fraction <= 0.3) {
              if (isNewCycle || sub.lastAlertSent?.threshold !== "24h") {
                neededThreshold = "24h";
              }
            }
          } else if (status === 1 /* Amber */) {
            if (isNewCycle || sub.lastAlertSent?.threshold !== "amber") {
              neededThreshold = "amber";
            }
          }
        }

        if (neededThreshold) {
          const dispatchRes = await dispatchHeartbeatAlert(
            sub,
            neededThreshold,
            secondsRemaining,
            baseUrl
          );

          if (dispatchRes.success) {
            await updateLastAlert(sub.vaultAddress, neededThreshold, lastCheckIn);
            alertsDispatched++;
          }

          results.push({
            vault: sub.vaultAddress,
            threshold: neededThreshold,
            secondsRemaining,
            notified: dispatchRes.channelsNotified,
          });
        } else {
          results.push({
            vault: sub.vaultAddress,
            status: status === 0 ? "Green" : status === 1 ? "Amber" : "Red",
            secondsRemaining,
            threshold: "none_needed",
          });
        }

        // ── Active Contestable Claims Monitoring (Milestones 3 & 4) ───────────
        try {
          const heirs = (await publicClient.readContract({
            address: sub.vaultAddress,
            abi: LegacyVaultABI,
            functionName: "getHeirs",
          })) as `0x${string}`[];

          if (heirs && heirs.length > 0) {
            const contestableWindowRaw = await publicClient.readContract({
              address: sub.vaultAddress,
              abi: LegacyVaultABI,
              functionName: "contestableWindow",
            });
            const contestableWindow = Number(contestableWindowRaw);

            for (const heir of heirs) {
              const [cStatusRaw, cInitRaw] = await Promise.all([
                publicClient.readContract({
                  address: sub.vaultAddress,
                  abi: LegacyVaultABI,
                  functionName: "claimStatus",
                  args: [heir],
                }),
                publicClient.readContract({
                  address: sub.vaultAddress,
                  abi: LegacyVaultABI,
                  functionName: "claimInitiatedAt",
                  args: [heir],
                }),
              ]);

              const cStatus = Number(cStatusRaw); // 1 = Contestable
              const cInit = Number(cInitRaw);

              // Active claim in progress: status is Contestable (1) and owner hasn't vetoed
              if (cStatus === 1 && cInit > 0 && lastCheckIn < cInit) {
                const vetoDeadline = cInit + contestableWindow;
                const claimSecondsRemaining = vetoDeadline - now;

                const lastClaimAlert = sub.lastClaimAlertSent;
                const isNewClaimCycle =
                  !lastClaimAlert ||
                  lastClaimAlert.claimInitiatedAt !== cInit ||
                  lastClaimAlert.heirAddress?.toLowerCase() !== heir.toLowerCase();

                let neededClaimThreshold: AlertThreshold | null = null;

                if (contestableWindow >= 86400) {
                  if (claimSecondsRemaining > 0 && claimSecondsRemaining <= 86400) {
                    if (isNewClaimCycle || lastClaimAlert.threshold !== "claim_expiring_24h") {
                      neededClaimThreshold = "claim_expiring_24h";
                    }
                  } else if (claimSecondsRemaining <= 0) {
                    if (isNewClaimCycle || lastClaimAlert.threshold !== "claim_expired") {
                      neededClaimThreshold = "claim_expired";
                    }
                  }
                } else {
                  const fraction = claimSecondsRemaining / contestableWindow;
                  if (claimSecondsRemaining > 0 && fraction <= 0.3) {
                    if (isNewClaimCycle || lastClaimAlert.threshold !== "claim_expiring_24h") {
                      neededClaimThreshold = "claim_expiring_24h";
                    }
                  } else if (claimSecondsRemaining <= 0) {
                    if (isNewClaimCycle || lastClaimAlert.threshold !== "claim_expired") {
                      neededClaimThreshold = "claim_expired";
                    }
                  }
                }

                if (neededClaimThreshold === "claim_expiring_24h") {
                  const dispatchRes = await dispatchClaimExpiringAlert(
                    sub,
                    heir,
                    claimSecondsRemaining,
                    baseUrl
                  );
                  if (dispatchRes.success) {
                    await updateLastClaimAlert(sub.vaultAddress, "claim_expiring_24h", cInit, heir);
                    alertsDispatched++;
                  }
                  results.push({
                    vault: sub.vaultAddress,
                    type: "claim_expiring_24h",
                    heir,
                    secondsRemaining: claimSecondsRemaining,
                    notified: dispatchRes.channelsNotified,
                  });
                } else if (neededClaimThreshold === "claim_expired") {
                  const dispatchRes = await dispatchClaimExpiredAlert(
                    sub,
                    heir,
                    baseUrl
                  );
                  if (dispatchRes.success) {
                    await updateLastClaimAlert(sub.vaultAddress, "claim_expired", cInit, heir);
                    alertsDispatched++;
                  }
                  results.push({
                    vault: sub.vaultAddress,
                    type: "claim_expired",
                    heir,
                    notified: dispatchRes.channelsNotified,
                  });
                }
              }
            }
          }
        } catch (claimErr) {
          console.warn(`[Cron] Error checking claims for vault ${sub.vaultAddress}:`, claimErr);
        }

        // ── Inheritance Asset Health Monitoring ───────────────────────────────
        // While the vault is Green or Amber, assess allocations.
        // If any allocations are underfunded and fingerprint has changed, dispatch email.
        if (status === 0 || status === 1) {
          try {
            const serverClient = getServerPublicClient();
            const allocations = await loadVaultAllocations(
              serverClient,
              sub.vaultAddress as `0x${string}`
            );

            if (allocations.length > 0) {
              const healthResults = await assessAllocations(
                serverClient,
                sub.vaultAddress as `0x${string}`,
                sub.ownerAddress as `0x${string}`,
                allocations
              );

              const underfunded = healthResults.filter((h) => h.state === "underfunded");
              if (underfunded.length > 0) {
                const fingerprint = underfunded
                  .map((h) => h.assetId.toLowerCase())
                  .sort()
                  .join(",");

                if (sub.lastFundingAlert?.fingerprint !== fingerprint) {
                  const underfundedDetails = underfunded.map((h) => ({
                    label: h.label || shortAddress(h.executor),
                    reason: getHealthReasonMessage(h.reason),
                  }));

                  const dispatchRes = await dispatchUnderfundedAlert(
                    sub,
                    underfundedDetails,
                    baseUrl
                  );

                  if (dispatchRes.success) {
                    await updateLastFundingAlert(sub.vaultAddress, fingerprint);
                    alertsDispatched++;
                  }

                  results.push({
                    vault: sub.vaultAddress,
                    type: "underfunded_alert",
                    fingerprint,
                    underfundedCount: underfunded.length,
                    notified: dispatchRes.channelsNotified,
                    error: dispatchRes.error,
                  });
                } else {
                  results.push({
                    vault: sub.vaultAddress,
                    type: "underfunded_suppressed_dedupe",
                    fingerprint,
                  });
                }
              }
            }
          } catch (fundingErr) {
            console.warn(`[Cron] Error checking funding health for vault ${sub.vaultAddress}:`, fundingErr);
            results.push({
              vault: sub.vaultAddress,
              type: "underfunded_check_failed",
              error: fundingErr instanceof Error ? fundingErr.message : String(fundingErr),
            });
          }
        }
      } catch (err) {
        console.error(`[Cron] Error evaluating vault ${sub.vaultAddress}:`, err);
        results.push({
          vault: sub.vaultAddress,
          error: err instanceof Error ? err.message : "Contract query failed",
        });
      }
    }

    return NextResponse.json({
      success: true,
      timestamp: now,
      processed: subscriptions.length,
      alertsDispatched,
      results,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Cron execution failed";
    console.error("[Cron Handler Error]", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
