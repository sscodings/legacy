"use client";

import React, { useEffect, useState } from "react";
import { VaultStatus, VAULT_STATUS_COPY, humanDuration } from "@/lib/constants";
import { RadialChronometer } from "./RadialChronometer";

interface LivenessPanelProps {
  status: VaultStatus;
  lastCheckIn: bigint;
  checkInInterval: bigint;
  gracePeriod: bigint;
  contestableWindow: bigint;
  livenessRegistered: boolean;
  isSettling?: boolean;
  onOpenCheckIn: () => void;
  onEditTiming: () => void;
}

const TRACK: { status: VaultStatus; label: string }[] = [
  { status: VaultStatus.Green, label: "Active" },
  { status: VaultStatus.Amber, label: "Grace period" },
  { status: VaultStatus.Red, label: "Claims open" },
];

function formatCountdown(totalSecs: number) {
  const d = Math.floor(totalSecs / 86400);
  const h = Math.floor((totalSecs % 86400) / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m`;
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  return `${pad(m)}m ${pad(s)}s`;
}

/**
 * The vault's single status card: a dial with the live countdown, one
 * sentence on what it means, one action, and the vault's timing rules.
 */
export function LivenessPanel({
  status,
  lastCheckIn,
  checkInInterval,
  gracePeriod,
  contestableWindow,
  livenessRegistered,
  isSettling,
  onOpenCheckIn,
  onEditTiming,
}: LivenessPanelProps) {
  const [elapsed, setElapsed] = useState<number>(0);

  useEffect(() => {
    const update = () => setElapsed(Math.floor(Date.now() / 1000) - Number(lastCheckIn));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [lastCheckIn]);

  const intervalSec = Number(checkInInterval);
  const graceSec = Number(gracePeriod);
  // Give the red zone a visible arc segment so the danger threshold reads on the dial.
  const redSpan = graceSec > 0 ? graceSec : Math.max(intervalSec, 1);
  const thresholds = {
    green: intervalSec,
    amber: intervalSec + graceSec,
    max: intervalSec + graceSec + redSpan,
  };

  const { timeLabel, timeText } =
    status === VaultStatus.Green
      ? { timeLabel: "Next check-in in", timeText: formatCountdown(Math.max(0, intervalSec - elapsed)) }
      : status === VaultStatus.Amber
      ? { timeLabel: "Claims open in", timeText: formatCountdown(Math.max(0, intervalSec + graceSec - elapsed)) }
      : { timeLabel: "Claims open for", timeText: formatCountdown(Math.max(0, elapsed - (intervalSec + graceSec))) };

  const statusColor = "var(--text-secondary)";

  const headline = !livenessRegistered
    ? "Set up World ID to start"
    : status === VaultStatus.Green
    ? "You're all set"
    : status === VaultStatus.Amber
    ? "You missed a check-in"
    : "Your heirs can claim";

  const description = !livenessRegistered
    ? "Link your World ID once. After that, checking in takes one scan."
    : status === VaultStatus.Green
    ? "Nothing to do until the timer runs out."
    : status === VaultStatus.Amber
    ? "Check in before the grace period ends to keep your vault active."
    : "Check in now to cancel any claim and reset the clock.";

  return (
    <section className="console-card status-card" aria-label="Vault status">
      <RadialChronometer
        value={livenessRegistered ? elapsed : 0}
        thresholds={thresholds}
        size={200}
        strokeWidth={10}
        className={isSettling ? "lamp-settle-animation" : undefined}
      >
        {livenessRegistered ? (
          <>
            <span className="status-dial-label">{timeLabel}</span>
            <span className="status-dial-time font-data" aria-live="polite">
              {timeText}
            </span>
          </>
        ) : (
          <span className="status-dial-label">Not set up</span>
        )}
      </RadialChronometer>

      <div className="status-body">
        <h2 className="status-headline" style={{ color: livenessRegistered ? "#ffffff" : statusColor }}>
          {headline}
        </h2>
        <p className="status-desc">{description}</p>

        <button type="button" onClick={onOpenCheckIn} className="flow-btn status-cta" id="trigger-checkin-btn">
          {livenessRegistered ? "Check in with World ID" : "Set up World ID"}
        </button>

        <ol className="status-track" aria-label="Vault lifecycle">
          {TRACK.map((step) => {
            const isCurrent = livenessRegistered && step.status === status;
            const isPast = livenessRegistered && step.status < status;
            return (
              <li
                key={step.label}
                className={`status-track-step${isCurrent ? " is-current" : ""}${isPast ? " is-past" : ""}`}
                style={isCurrent ? ({ "--track-color": VAULT_STATUS_COPY[step.status].color } as React.CSSProperties) : undefined}
                aria-current={isCurrent ? "step" : undefined}
              >
                {step.label}
              </li>
            );
          })}
        </ol>

        <div className="status-timing">
          <span>
            Check in every <strong>{humanDuration(intervalSec)}</strong>
          </span>
          <span title="How long after a missed check-in before your heirs can start a claim">
            Grace <strong>{humanDuration(graceSec)}</strong>
          </span>
          <span title="How long you have to cancel a claim by checking in">
            Veto window <strong>{humanDuration(Number(contestableWindow))}</strong>
          </span>
          <button type="button" onClick={onEditTiming} className="flow-link status-timing-edit">
            Change timing →
          </button>
        </div>
      </div>
    </section>
  );
}
