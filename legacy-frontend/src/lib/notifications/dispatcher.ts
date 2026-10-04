import { VaultNotificationSubscription, AlertThreshold, NotificationChannel } from "@/types/notifications";
import { sendEmailNotification } from "./email";
import { sendPushNotification } from "./push";
import { recordAlertLog } from "./store";

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return `${d}d ${h}h`;
}

function generateEmailTemplate({
  headline,
  statusColor,
  statusBadge,
  vaultAddress,
  explanation,
  timeHighlight,
  ctaText,
  ctaUrl,
}: {
  headline: string;
  statusColor: string;
  statusBadge: string;
  vaultAddress: string;
  explanation: string;
  timeHighlight: string;
  ctaText: string;
  ctaUrl: string;
}) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${headline}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #10151A; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #EDEAE3;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #10151A; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" max-width="580" border="0" cellspacing="0" cellpadding="0" style="max-width: 580px; background-color: #1C2226; border: 1px solid #2E353A; border-radius: 4px; overflow: hidden;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 28px 32px; border-bottom: 1px solid #2E353A; background-color: #141A1E;">
              <table width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td>
                    <span style="font-size: 16px; font-weight: 700; letter-spacing: 0.1em; color: #EDEAE3; text-transform: uppercase;">
                      LEGACY PROTOCOL
                    </span>
                  </td>
                  <td align="right">
                    <span style="display: inline-block; padding: 4px 10px; font-size: 11px; font-family: monospace; font-weight: 700; text-transform: uppercase; border-radius: 2px; color: ${statusColor}; background-color: rgba(255, 255, 255, 0.05); border: 1px solid ${statusColor};">
                      ${statusBadge}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 32px;">
              <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #EDEAE3; line-height: 1.3;">
                ${headline}
              </h1>

              <div style="background-color: #10151A; border: 1px solid #2E353A; padding: 12px 16px; margin-bottom: 24px; font-family: monospace; font-size: 13px; color: #9A9E98; word-break: break-all;">
                Vault: <strong style="color: #EDEAE3;">${vaultAddress}</strong>
              </div>

              <p style="margin: 0 0 20px 0; font-size: 15px; line-height: 1.6; color: #EDEAE3;">
                ${explanation}
              </p>

              <!-- Highlight Readout Box -->
              <table width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-bottom: 28px; background-color: #10151A; border: 1px solid #2E353A; border-left: 3px solid ${statusColor};">
                <tr>
                  <td style="padding: 16px 20px;">
                    <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #9A9E98; margin-bottom: 4px;">
                      Time Window Remaining
                    </div>
                    <div style="font-size: 24px; font-weight: 700; font-family: monospace; color: ${statusColor};">
                      ${timeHighlight}
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Call to Action Button -->
              <table width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center">
                    <a href="${ctaUrl}" target="_blank" style="display: inline-block; width: 100%; text-align: center; box-sizing: border-box; background-color: #B8894A; color: #10151A; padding: 14px 24px; font-size: 14px; font-weight: 700; text-decoration: none; border-radius: 4px; letter-spacing: 0.02em;">
                      ${ctaText} →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 20px 32px; border-top: 1px solid #2E353A; background-color: #141A1E; font-size: 12px; color: #9A9E98; line-height: 1.5;">
              This is an autonomous on-chain alert dispatched by Legacy Protocol on World Chain Sepolia.<br>
              You received this message because this email was designated as the emergency contact for vault <code>${vaultAddress}</code>.
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

export async function dispatchHeartbeatAlert(
  sub: VaultNotificationSubscription,
  threshold: AlertThreshold,
  secondsRemaining: number,
  baseUrl: string = process.env.NEXT_PUBLIC_APP_URL || "https://legacy-drab-two.vercel.app"
): Promise<{ success: boolean; channelsNotified: string[] }> {
  const shortVault = `${sub.vaultAddress.slice(0, 6)}...${sub.vaultAddress.slice(-4)}`;
  const formattedTime = formatDuration(secondsRemaining);
  const vaultUrl = baseUrl;

  let subject = `[Legacy Vault] Proof-of-Liveness Check-In Due in ${formattedTime}`;
  let statusBadge = "Green Status Expirable";
  let statusColor = "#D99A3D"; // Amber
  let explanation = `Your vault check-in cadence requires a proof-of-liveness heartbeat within ${formattedTime}. If no check-in occurs, the vault will transition into the Amber grace period.`;

  if (threshold === "24h" || secondsRemaining <= 86400) {
    subject = `[URGENT] Legacy Vault Enters Amber Grace Period in ${formattedTime}`;
    statusBadge = "Imminent Amber";
    statusColor = "#D99A3D";
    explanation = `Your Legacy Vault will transition into the <strong>Amber Grace Period</strong> in ${formattedTime}. Verify your liveness with World ID to keep your vault in the Green state and prevent estate succession.`;
  } else if (threshold === "amber") {
    subject = `[ALERT] Legacy Vault Has Entered Amber Grace Period`;
    statusBadge = "Amber Status";
    statusColor = "#D99A3D";
    explanation = `Your vault has entered the <strong>Amber Grace Period</strong>. You have ${formattedTime} to check in before the vault enters Red and authorized heirs may initiate claims.`;
  }

  const html = generateEmailTemplate({
    headline: subject.replace(/^\[.*?\]\s*/, ""),
    statusColor,
    statusBadge,
    vaultAddress: sub.vaultAddress,
    explanation,
    timeHighlight: formattedTime,
    ctaText: "Check In with World ID",
    ctaUrl: vaultUrl,
  });

  const channelsNotified: string[] = [];

  // Email dispatch
  if (sub.email) {
    const res = await sendEmailNotification({
      to: sub.email,
      subject,
      html,
      text: `${explanation}\n\nCheck-in required within: ${formattedTime}\nOpen Vault: ${vaultUrl}`,
    });
    if (res.success) {
      channelsNotified.push("email");
    }
  }

  // Push Protocol
  if (sub.pushEnabled) {
    const res = await sendPushNotification({
      recipientAddress: sub.ownerAddress,
      title: subject,
      body: `Vault ${shortVault}: ${formattedTime} remaining before Amber status.`,
      ctaUrl: vaultUrl,
    });
    if (res.success) channelsNotified.push(res.simulated ? "push (simulated)" : "push");
  }

  await recordAlertLog(sub.vaultAddress, {
    threshold,
    title: subject,
    message: `${formattedTime} remaining before status change.`,
    channel: "all",
    success: channelsNotified.length > 0,
  });

  return { success: channelsNotified.length > 0, channelsNotified };
}

export const SEVEN_DAYS_SECONDS = 604800;

export async function dispatchVaultCreatedAlert(
  sub: VaultNotificationSubscription,
  checkInIntervalSeconds: number,
  baseUrl: string = process.env.NEXT_PUBLIC_APP_URL || "https://legacy-drab-two.vercel.app"
): Promise<{ success: boolean; channelsNotified: string[] }> {
  const shortVault = `${sub.vaultAddress.slice(0, 6)}...${sub.vaultAddress.slice(-4)}`;
  const formattedInterval = formatDuration(checkInIntervalSeconds);
  const vaultUrl = baseUrl;

  const subject = `[Legacy Vault] Vault Armed — Short ${formattedInterval} Liveness Window`;
  const explanation = `Your Legacy Vault <code>${shortVault}</code> is now live and monitored. You configured a proof-of-liveness cadence of <strong>${formattedInterval}</strong>, which is under the standard 7-day window — so your first check-in deadline will arrive soon and the window will get over quickly. Perform a World ID check-in before it closes to keep the vault in the Green state.`;

  const html = generateEmailTemplate({
    headline: "Vault Armed — Liveness Window Closing Soon",
    statusColor: "#D99A3D", // Amber
    statusBadge: "Short Window",
    vaultAddress: sub.vaultAddress,
    explanation,
    timeHighlight: `${formattedInterval} cadence`,
    ctaText: "Check In with World ID",
    ctaUrl: vaultUrl,
  });

  const channelsNotified: string[] = [];

  if (sub.email) {
    const res = await sendEmailNotification({
      to: sub.email,
      subject,
      html,
      text: `Your Legacy Vault ${sub.vaultAddress} is armed with a short ${formattedInterval} liveness window and will get over soon. Check in with World ID: ${vaultUrl}`,
    });
    if (res.success) channelsNotified.push("email");
  }

  if (sub.pushEnabled) {
    const res = await sendPushNotification({
      recipientAddress: sub.ownerAddress,
      title: "Legacy Vault Armed — Short Window",
      body: `Vault ${shortVault} created with a ${formattedInterval} cadence. Check in soon.`,
      ctaUrl: vaultUrl,
    });
    if (res.success) channelsNotified.push(res.simulated ? "push (simulated)" : "push");
  }

  await recordAlertLog(sub.vaultAddress, {
    threshold: "vault_created",
    title: subject,
    message: `Vault armed with a short ${formattedInterval} liveness window.`,
    channel: "all",
    success: channelsNotified.length > 0,
  });

  return { success: channelsNotified.length > 0, channelsNotified };
}

export async function dispatchClaimAlert(
  sub: VaultNotificationSubscription,
  heirAddress: `0x${string}`,
  contestableWindowSeconds: number,
  txHash?: `0x${string}`,
  baseUrl: string = process.env.NEXT_PUBLIC_APP_URL || "https://legacy-drab-two.vercel.app"
): Promise<{ success: boolean; channelsNotified: string[] }> {
  const shortVault = `${sub.vaultAddress.slice(0, 6)}...${sub.vaultAddress.slice(-4)}`;
  const shortHeir = `${heirAddress.slice(0, 6)}...${heirAddress.slice(-4)}`;
  const windowTime = formatDuration(contestableWindowSeconds);
  const vaultUrl = baseUrl;

  const subject = `[URGENT] Contestable Succession Claim Initiated on Vault ${shortVault}`;
  const explanation = `Heir <code>${heirAddress}</code> has initiated succession on your Legacy Vault. The contestable challenge window is now running.<br><br><strong>Owner Veto Right:</strong> If you are alive and well, you can invalidate and abort this claim at any time during this window simply by performing a World ID check-in.`;

  const html = generateEmailTemplate({
    headline: "Contestable Succession Claim Initiated",
    statusColor: "#C1503F", // Red
    statusBadge: "Contestable Claim",
    vaultAddress: sub.vaultAddress,
    explanation,
    timeHighlight: `${windowTime} to Veto`,
    ctaText: "Veto Claim & Check In Now",
    ctaUrl: vaultUrl,
  });

  const channelsNotified: string[] = [];

  // Email dispatch
  if (sub.email) {
    const res = await sendEmailNotification({
      to: sub.email,
      subject,
      html,
      text: `Contestable claim initiated by ${heirAddress}. You have ${windowTime} to check in and veto.\n\nOpen Vault: ${vaultUrl}`,
    });
    if (res.success) {
      channelsNotified.push("email");
    }
  }

  // Push Protocol
  if (sub.pushEnabled) {
    const res = await sendPushNotification({
      recipientAddress: sub.ownerAddress,
      title: "CONTESTABLE CLAIM INITIATED",
      body: `Heir ${shortHeir} initiated claim. You have ${windowTime} to veto by checking in.`,
      ctaUrl: vaultUrl,
    });
    if (res.success) channelsNotified.push(res.simulated ? "push (simulated)" : "push");
  }

  await recordAlertLog(sub.vaultAddress, {
    threshold: "claim_initiated",
    title: subject,
    message: `Heir ${shortHeir} initiated claim. Contestable window: ${windowTime}.`,
    channel: "all",
    success: channelsNotified.length > 0,
  });

  return { success: channelsNotified.length > 0, channelsNotified };
}

export async function dispatchClaimExpiringAlert(
  sub: VaultNotificationSubscription,
  heirAddress: `0x${string}`,
  secondsRemaining: number,
  baseUrl: string = process.env.NEXT_PUBLIC_APP_URL || "https://legacy-drab-two.vercel.app"
): Promise<{ success: boolean; channelsNotified: string[] }> {
  const shortVault = `${sub.vaultAddress.slice(0, 6)}...${sub.vaultAddress.slice(-4)}`;
  const shortHeir = `${heirAddress.slice(0, 6)}...${heirAddress.slice(-4)}`;
  const formattedTime = formatDuration(secondsRemaining);
  const vaultUrl = baseUrl;

  const subject = `[URGENT] Final ${formattedTime} to Veto Succession Claim on Vault ${shortVault}`;
  const explanation = `The contestable challenge window for the succession claim initiated by heir <code>${heirAddress}</code> is about to close in <strong>${formattedTime}</strong>.<br><br><strong>Owner Veto Right:</strong> If you are alive and wish to retain custody of your assets, you must perform a World ID check-in immediately before this window closes to invalidate this claim.`;

  const html = generateEmailTemplate({
    headline: "Final Hours to Veto Succession Claim",
    statusColor: "#C1503F",
    statusBadge: "Veto Window Closing",
    vaultAddress: sub.vaultAddress,
    explanation,
    timeHighlight: `${formattedTime} to Veto`,
    ctaText: "Veto Claim & Check In Now",
    ctaUrl: vaultUrl,
  });

  const channelsNotified: string[] = [];

  if (sub.email) {
    const res = await sendEmailNotification({
      to: sub.email,
      subject,
      html,
      text: `FINAL NOTICE: Only ${formattedTime} remaining to veto the claim initiated by ${heirAddress}. Check in to veto: ${vaultUrl}`,
    });
    if (res.success) channelsNotified.push("email");
  }

  if (sub.pushEnabled) {
    const res = await sendPushNotification({
      recipientAddress: sub.ownerAddress,
      title: "FINAL HOURS TO VETO CLAIM",
      body: `Vault ${shortVault}: Only ${formattedTime} remaining to veto heir ${shortHeir}'s claim.`,
      ctaUrl: vaultUrl,
    });
    if (res.success) channelsNotified.push(res.simulated ? "push (simulated)" : "push");
  }

  await recordAlertLog(sub.vaultAddress, {
    threshold: "claim_expiring_24h",
    title: subject,
    message: `Contestable window ending soon for heir ${shortHeir}. ${formattedTime} left to veto.`,
    channel: "all",
    success: channelsNotified.length > 0,
  });

  return { success: channelsNotified.length > 0, channelsNotified };
}

export async function dispatchClaimExpiredAlert(
  sub: VaultNotificationSubscription,
  heirAddress: `0x${string}`,
  baseUrl: string = process.env.NEXT_PUBLIC_APP_URL || "https://legacy-drab-two.vercel.app"
): Promise<{ success: boolean; channelsNotified: string[] }> {
  const shortVault = `${sub.vaultAddress.slice(0, 6)}...${sub.vaultAddress.slice(-4)}`;
  const shortHeir = `${heirAddress.slice(0, 6)}...${heirAddress.slice(-4)}`;
  const vaultUrl = baseUrl;

  const subject = `[NOTICE] Contestable Challenge Window Closed on Vault ${shortVault}`;
  const explanation = `The contestable challenge window on vault <code>${sub.vaultAddress}</code> has concluded without an owner veto. Heir <code>${heirAddress}</code> is now eligible to finalize and claim their allocated assets.`;

  const html = generateEmailTemplate({
    headline: "Contestable Window Has Closed",
    statusColor: "#C1503F",
    statusBadge: "Claim Eligible",
    vaultAddress: sub.vaultAddress,
    explanation,
    timeHighlight: "Window Closed",
    ctaText: "View Vault Dashboard",
    ctaUrl: vaultUrl,
  });

  const channelsNotified: string[] = [];

  if (sub.email) {
    const res = await sendEmailNotification({
      to: sub.email,
      subject,
      html,
      text: `Notice: Contestable challenge window has closed without veto on vault ${sub.vaultAddress}. Heir ${heirAddress} can now finalize claim.\n\nOpen Vault: ${vaultUrl}`,
    });
    if (res.success) channelsNotified.push("email");
  }

  if (sub.pushEnabled) {
    const res = await sendPushNotification({
      recipientAddress: sub.ownerAddress,
      title: "CONTESTABLE WINDOW CLOSED",
      body: `Vault ${shortVault}: Contestable window elapsed. Heir ${shortHeir} can now finalize claim.`,
      ctaUrl: vaultUrl,
    });
    if (res.success) channelsNotified.push(res.simulated ? "push (simulated)" : "push");
  }

  await recordAlertLog(sub.vaultAddress, {
    threshold: "claim_expired",
    title: subject,
    message: `Contestable window expired for heir ${shortHeir}. Claim is eligible for finalization.`,
    channel: "all",
    success: channelsNotified.length > 0,
  });

  return { success: channelsNotified.length > 0, channelsNotified };
}

export async function dispatchTestAlert(
  sub: VaultNotificationSubscription,
  channel: NotificationChannel | "all" = "all",
  baseUrl: string = process.env.NEXT_PUBLIC_APP_URL || "https://legacy-drab-two.vercel.app"
): Promise<{ success: boolean; channelsNotified: string[]; error?: string }> {
  const shortVault = `${sub.vaultAddress.slice(0, 6)}...${sub.vaultAddress.slice(-4)}`;
  const vaultUrl = baseUrl;

  const subject = `[Legacy Protocol] Watchdog Alert System Verification`;
  const explanation = `This is a test notification confirming that your emergency dispatch pipeline is active and armed for vault <code>${sub.vaultAddress}</code>.<br><br>You will automatically receive pre-Amber heartbeat cadence warnings and instant alerts if any heir initiates succession.`;

  const html = generateEmailTemplate({
    headline: "Watchdog Alert Pipe Verified",
    statusColor: "#4CAF6D", // Green
    statusBadge: "Watchdog Armed",
    vaultAddress: sub.vaultAddress,
    explanation,
    timeHighlight: "Monitoring Active",
    ctaText: "Open Vault Dashboard",
    ctaUrl: vaultUrl,
  });

  const channelsNotified: string[] = [];

  if ((channel === "all" || channel === "email") && sub.email) {
    const res = await sendEmailNotification({
      to: sub.email,
      subject,
      html,
      text: `Watchdog verification test for vault ${sub.vaultAddress}. Dispatch active.`,
    });
    if (res.success) {
      channelsNotified.push("email");
    } else {
      return { success: false, channelsNotified, error: res.error };
    }
  }

  if ((channel === "all" || channel === "push") && sub.pushEnabled) {
    const res = await sendPushNotification({
      recipientAddress: sub.ownerAddress,
      title: "WATCHDOG TEST ALERT",
      body: `Watchdog test alert for vault ${shortVault}. Notification channel verified.`,
      ctaUrl: vaultUrl,
    });
    if (res.success) {
      channelsNotified.push(res.simulated ? "push (simulated)" : "push");
    } else {
      return { success: false, channelsNotified, error: res.error };
    }
  }

  await recordAlertLog(sub.vaultAddress, {
    threshold: "test",
    title: subject,
    message: "Manual watchdog test verification completed.",
    channel,
    success: channelsNotified.length > 0,
  });

  return { success: channelsNotified.length > 0, channelsNotified };
}

export interface UnderfundedAssetItem {
  label: string;
  reason: string;
}

export async function dispatchUnderfundedAlert(
  sub: VaultNotificationSubscription,
  underfundedAssets: UnderfundedAssetItem[],
  baseUrl: string = process.env.NEXT_PUBLIC_APP_URL || "https://legacy-drab-two.vercel.app"
): Promise<{ success: boolean; channelsNotified: string[]; error?: string }> {
  if (!sub.email) {
    return { success: false, channelsNotified: [], error: "No email registered for vault" };
  }

  const shortVault = `${sub.vaultAddress.slice(0, 6)}...${sub.vaultAddress.slice(-4)}`;
  const subject = `[Legacy Alert] Inheritance assets underfunded: Vault ${shortVault}`;
  const vaultUrl = `${baseUrl}/vault?v=${sub.vaultAddress}&tab=assets`;

  const assetListText = underfundedAssets
    .map((a) => `• ${a.label}: ${a.reason}`)
    .join("\n");

  const assetListHtml = underfundedAssets
    .map((a) => `<li style="margin-bottom: 6px;"><strong>${a.label}</strong> — <span style="color: #D99A3D;">${a.reason}</span></li>`)
    .join("");

  const explanation = `An autonomous check of your vault detected that one or more allocated assets cannot currently pay out upon succession:<br><ul style="margin: 12px 0 16px 20px; padding: 0; line-height: 1.6;">${assetListHtml}</ul>Top up the required token balances or update your token allowances so heirs can successfully receive their assigned inheritance.`;

  const html = generateEmailTemplate({
    headline: "Inheritance Assets Underfunded",
    statusColor: "#D99A3D",
    statusBadge: "UNDERFUNDED",
    vaultAddress: sub.vaultAddress,
    explanation,
    timeHighlight: `${underfundedAssets.length} asset${underfundedAssets.length > 1 ? "s" : ""} at risk`,
    ctaText: "Review Vault Assets",
    ctaUrl: vaultUrl,
  });

  const channelsNotified: string[] = [];

  const res = await sendEmailNotification({
    to: sub.email,
    subject,
    html,
    text: `Legacy Protocol Alert: Inheritance assets are currently underfunded for vault ${sub.vaultAddress}.\n\n${assetListText}\n\nReview your vault: ${vaultUrl}`,
  });

  if (res.success) {
    channelsNotified.push("email");
  } else {
    return { success: false, channelsNotified, error: res.error };
  }

  await recordAlertLog(sub.vaultAddress, {
    threshold: "underfunded",
    title: subject,
    message: `${underfundedAssets.length} asset(s) underfunded: ${underfundedAssets.map((a) => a.label).join(", ")}`,
    channel: "email",
    success: true,
  });

  return { success: true, channelsNotified };
}

