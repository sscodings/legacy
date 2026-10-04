"use client";

import React, { useRef, useState } from "react";
import { VaultStatus, PROTOCOL_FLOORS, humanDuration } from "@/lib/constants";

interface VaultParametersProps {
  checkInInterval: bigint;
  gracePeriod: bigint;
  contestableWindow: bigint;
  vaultStatus: VaultStatus;
  onUpdateParameters: (
    newInterval: bigint,
    newGrace: bigint,
    newContestable: bigint
  ) => Promise<void>;
  isLoading?: boolean;
}

const UNITS = [
  { label: "seconds", seconds: 1 },
  { label: "minutes", seconds: 60 },
  { label: "hours", seconds: 3600 },
  { label: "days", seconds: 86400 },
] as const;

type FieldKey = "interval" | "grace" | "veto";
type Duration = { amount: string; unit: number };
type Durations = Record<FieldKey, Duration>;

const FIELDS: { key: FieldKey; label: string; hint: string; min: number }[] = [
  { key: "interval", label: "Check in every", hint: "How often you prove you're alive.", min: PROTOCOL_FLOORS.minCheckInIntervalSeconds },
  { key: "grace", label: "Grace period", hint: "Extra time after a missed check-in.", min: 0 },
  { key: "veto", label: "Veto window", hint: "Time you have to cancel an heir's claim.", min: PROTOCOL_FLOORS.minContestableWindowSeconds },
];

const PRESETS: { id: string; label: string; seconds: Record<FieldKey, number> }[] = [
  { id: "demo", label: "Quick demo", seconds: { interval: 45, grace: 15, veto: 45 } },
  { id: "standard", label: "Standard", seconds: { interval: 86400 * 30, grace: 86400 * 7, veto: 3600 * 48 } },
];

const safeSeconds = (n: number) => (Number.isFinite(n) && n >= 0 ? n : 0);

/**
 * A compact clock face previewing the three phases as proportional arcs of
 * one full cycle: checking-in (green) → grace (amber) → veto window (red).
 * Purely a live preview of the form values below — not a countdown.
 */
function TimingClockPreview({
  intervalSec,
  graceSec,
  vetoSec,
  size = 168,
  strokeWidth = 14,
}: {
  intervalSec: number;
  graceSec: number;
  vetoSec: number;
  size?: number;
  strokeWidth?: number;
}) {
  const total = Math.max(intervalSec + graceSec + vetoSec, 1);
  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const frac = (s: number) => s / total;
  const greenEnd = frac(intervalSec);
  const amberEnd = greenEnd + frac(graceSec);

  // Rotate so drawing starts at 12 o'clock and sweeps clockwise, like the status dial.
  const ringTransform = `rotate(-90 ${cx} ${cy})`;
  const band = (from: number, to: number) => ({
    strokeDasharray: `${Math.max(to - from, 0) * circumference} ${circumference}`,
    strokeDashoffset: `${-from * circumference}`,
  });

  // 60 evenly spaced clock-face ticks (like minute marks), longer/brighter at
  // each of the 12 "hour" positions — purely decorative, reads as a clock.
  const tickOuter = r - strokeWidth / 2 - 3;
  const ticks = Array.from({ length: 60 }, (_, i) => {
    const isHour = i % 5 === 0;
    const angle = (i / 60) * 2 * Math.PI - Math.PI / 2;
    const inner = tickOuter - (isHour ? 9 : 4);
    return {
      key: i,
      isHour,
      x1: cx + Math.cos(angle) * inner,
      y1: cy + Math.sin(angle) * inner,
      x2: cx + Math.cos(angle) * tickOuter,
      y2: cy + Math.sin(angle) * tickOuter,
    };
  });

  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Timing cycle preview">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border-hairline)" strokeWidth={strokeWidth} />
        <g transform={ringTransform} strokeWidth={strokeWidth} fill="none" strokeLinecap="butt">
          <circle cx={cx} cy={cy} r={r} stroke="var(--status-green)" style={{ transition: "stroke-dasharray 300ms ease-out" }} {...band(0, greenEnd)} />
          <circle cx={cx} cy={cy} r={r} stroke="var(--status-amber)" style={{ transition: "stroke-dasharray 300ms ease-out, stroke-dashoffset 300ms ease-out" }} {...band(greenEnd, amberEnd)} />
          <circle cx={cx} cy={cy} r={r} stroke="var(--status-red)" style={{ transition: "stroke-dasharray 300ms ease-out, stroke-dashoffset 300ms ease-out" }} {...band(amberEnd, 1)} />
        </g>
        {/* Clock-face tick marks, inside the ring */}
        <g>
          {ticks.map((t) => (
            <line
              key={t.key}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke={t.isHour ? "var(--text-secondary)" : "var(--border-mid, rgba(255,255,255,0.15))"}
              strokeWidth={t.isHour ? 2 : 1}
              strokeLinecap="round"
            />
          ))}
        </g>
        {/* 12 o'clock marker, echoing the check-in ritual's "reset to top" moment */}
        <circle cx={cx} cy={strokeWidth / 2 + 1} r={2} fill="var(--text-secondary)" />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: strokeWidth + 6,
          pointerEvents: "none",
        }}
      >
        <span className="font-data" style={{ fontSize: "1rem", fontWeight: 700, color: "#ffffff", lineHeight: 1.2 }}>
          {humanDuration(total, 1)}
        </span>
        <span style={{ fontSize: "0.6875rem", color: "var(--text-secondary)" }}>full cycle</span>
      </div>
    </div>
  );
}

function ClockLegendRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: "0.8125rem" }}>
      <span style={{ width: 9, height: 9, borderRadius: "50%", backgroundColor: color, flexShrink: 0, boxShadow: `0 0 6px ${color}` }} />
      <span style={{ color: "var(--text-secondary)", flex: 1 }}>{label}</span>
      <span className="font-data" style={{ color: "#ffffff", fontWeight: 600 }}>{value}</span>
    </div>
  );
}

/** Express seconds in the largest unit that divides evenly: 2592000 → 30 days. */
function toDuration(totalSeconds: number): Duration {
  for (let i = UNITS.length - 1; i > 0; i--) {
    const size = UNITS[i].seconds;
    if (totalSeconds > 0 && totalSeconds % size === 0) {
      return { amount: String(totalSeconds / size), unit: size };
    }
  }
  return { amount: String(totalSeconds), unit: 1 };
}

function toSeconds(d: Duration): number {
  const n = Number(d.amount);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * d.unit) : NaN;
}

/** One lap's full-scale ceiling — generous enough to cover the "Standard" preset. */
const DIAL_MAX_SECONDS = 86400 * 30;
/** Hard ceiling regardless of how many extra laps are spun — 10 years. */
const ABSOLUTE_MAX_SECONDS = 86400 * 3650;

const FIELD_COLOR: Record<FieldKey, string> = {
  interval: "var(--status-green)",
  grace: "var(--status-amber)",
  veto: "var(--status-red)",
};

/** Turns (1.0 = one full lap) → seconds. Lap 1 is log-scaled min→max; each
 *  extra lap beyond that adds another full `max` worth of seconds linearly. */
function secondsFromTurns(turns: number, min: number, max: number, logMin: number, logMax: number): number {
  const t = Math.max(0, turns);
  if (t <= 1) {
    if (logMax === logMin) return min;
    return Math.exp(logMin + t * (logMax - logMin));
  }
  return max * t;
}

/** Inverse of {@link secondsFromTurns} — recovers the turn count a committed value represents. */
function turnsFromSeconds(seconds: number, max: number, logMin: number, logMax: number): number {
  const v = Math.max(0, seconds);
  if (v <= max) {
    if (logMax === logMin) return 0;
    return Math.min(Math.max((Math.log(Math.max(v, 1)) - logMin) / (logMax - logMin), 0), 1);
  }
  return v / max;
}

/** Snap a raw log-scale drag value to a friendlier increment based on its magnitude. */
function niceRoundSeconds(s: number): number {
  const v = Math.max(0, s);
  if (v < 60) return Math.round(v);
  if (v < 3600) return Math.round(v / 15) * 15;
  if (v < 86400) return Math.round(v / 300) * 300;
  if (v < 86400 * 7) return Math.round(v / 3600) * 3600;
  return Math.round(v / 86400) * 86400;
}

interface DurationDialProps {
  /** current value in seconds; NaN while the field is empty/invalid */
  seconds: number;
  min: number;
  max: number;
  color: string;
  label: string;
  disabled?: boolean;
  onChange: (seconds: number) => void;
  size?: number;
}

/**
 * A single draggable ring standing in for a duration field: drag (or arrow
 * keys) around it to set the value. One lap covers the log-scaled min→max
 * range; rolling past 12 o'clock keeps adding another full lap's worth of
 * time, with each completed lap left behind as a solid accent-colored ring
 * that the current lap's progress overlaps as it sweeps around again.
 */
function DurationDial({ seconds, min, max, color, label, disabled, onChange, size = 108 }: DurationDialProps) {
  const strokeWidth = 9;
  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;

  const logMin = Math.log(Math.max(min, 1));
  const logMax = Math.log(Math.max(max, min + 1));
  const current = Number.isFinite(seconds) ? seconds : min;
  const clamped = Math.min(Math.max(current, min), ABSOLUTE_MAX_SECONDS);

  const turns = turnsFromSeconds(clamped, max, logMin, logMax);
  const lapsCompleted = Math.floor(turns);
  const lapFrac = turns - lapsCompleted;

  const ringTransform = `rotate(-90 ${cx} ${cy})`;

  // Tracks continuous rotation across the drag gesture (in "turns"), so
  // crossing 12 o'clock keeps accumulating instead of wrapping/jumping.
  const dragRef = useRef<{ prevFrac: number; turns: number } | null>(null);

  const fracFromPoint = (clientX: number, clientY: number, el: Element) => {
    const rect = el.getBoundingClientRect();
    const x = clientX - (rect.left + rect.width / 2);
    const y = clientY - (rect.top + rect.height / 2);
    let deg = (Math.atan2(y, x) * 180) / Math.PI + 90;
    if (deg < 0) deg += 360;
    return deg / 360;
  };

  const commitTurns = (nextTurns: number) => {
    const clampedTurns = Math.max(0, nextTurns);
    const raw = secondsFromTurns(clampedTurns, min, max, logMin, logMax);
    onChange(Math.min(Math.max(niceRoundSeconds(raw), min), ABSOLUTE_MAX_SECONDS));
  };

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const f = fracFromPoint(e.clientX, e.clientY, e.currentTarget);
    dragRef.current = { prevFrac: f, turns };
    // Jump straight to the pointer's position on the initial click, same as before.
    commitTurns(lapsCompleted + f);
  };
  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (disabled || e.buttons !== 1 || !dragRef.current) return;
    const f = fracFromPoint(e.clientX, e.clientY, e.currentTarget);
    let delta = f - dragRef.current.prevFrac;
    // Shortest path across the 0/1 wrap boundary — this is what lets a lap
    // "complete" smoothly instead of snapping backwards through the dial.
    if (delta > 0.5) delta -= 1;
    if (delta < -0.5) delta += 1;
    const nextTurns = dragRef.current.turns + delta;
    dragRef.current = { prevFrac: f, turns: nextTurns };
    commitTurns(nextTurns);
  };
  const handlePointerUp = () => {
    dragRef.current = null;
  };

  const step = (dir: 1 | -1) => {
    if (disabled) return;
    const base = Math.max(current, min, 1);
    const delta = Math.exp(Math.log(base) + dir * (logMax - logMin) * 0.03) - base;
    const next = current + (delta !== 0 ? delta : dir);
    onChange(Math.min(Math.max(niceRoundSeconds(next), min), ABSOLUTE_MAX_SECONDS));
  };

  const knobAngleRad = (lapFrac * 360 - 90) * (Math.PI / 180);
  const knobX = cx + Math.cos(knobAngleRad) * r;
  const knobY = cy + Math.sin(knobAngleRad) * r;
  const accentColor = "var(--accent-brass)";

  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={ABSOLUTE_MAX_SECONDS}
      aria-valuenow={Math.round(clamped)}
      aria-valuetext={Number.isFinite(seconds) ? humanDuration(seconds) : "unset"}
      aria-disabled={disabled}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowRight") {
          e.preventDefault();
          step(1);
        } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
          e.preventDefault();
          step(-1);
        }
      }}
      style={{ position: "relative", width: size, height: size, outline: "none", touchAction: "none" }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ cursor: disabled ? "default" : "grab", display: "block" }}
      >
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border-hairline)" strokeWidth={strokeWidth} />
        {/* Solid accent ring left behind by each fully completed lap — the
            current lap's arc below overlaps it, growing on top as it sweeps. */}
        {lapsCompleted >= 1 && (
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={accentColor}
            strokeWidth={strokeWidth}
            style={{ opacity: disabled ? 0.35 : 0.85 }}
          />
        )}
        <g transform={ringTransform}>
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            style={{
              strokeDasharray: `${Math.max(lapFrac, lapsCompleted >= 1 ? 0 : 0.01) * circumference} ${circumference}`,
              opacity: disabled ? 0.4 : 1,
              transition: "stroke-dasharray 120ms ease-out",
              filter: disabled ? undefined : `drop-shadow(0 0 4px ${color})`,
            }}
          />
        </g>
        {!disabled && <circle cx={knobX} cy={knobY} r={5} fill="#ffffff" stroke={color} strokeWidth={2} />}
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
          padding: strokeWidth + 6,
          textAlign: "center",
        }}
      >
        <span
          className="font-data"
          style={{ fontSize: "0.8125rem", fontWeight: 700, color: disabled ? "var(--text-secondary)" : "#ffffff", lineHeight: 1.2 }}
        >
          {Number.isFinite(seconds) ? humanDuration(seconds, 1) : "—"}
        </span>
        {lapsCompleted >= 1 && (
          <span className="font-data" style={{ fontSize: "0.625rem", color: accentColor, marginTop: 2 }}>
            +{lapsCompleted} lap{lapsCompleted === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </div>
  );
}

function fromChain(interval: bigint, grace: bigint, veto: bigint): Durations {
  return {
    interval: toDuration(Number(interval)),
    grace: toDuration(Number(grace)),
    veto: toDuration(Number(veto)),
  };
}

export function VaultParameters({
  checkInInterval,
  gracePeriod,
  contestableWindow,
  vaultStatus,
  onUpdateParameters,
  isLoading = false,
}: VaultParametersProps) {
  const [values, setValues] = useState<Durations>(() => fromChain(checkInInterval, gracePeriod, contestableWindow));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);

  // Re-sync with on-chain values when they change (async load, or refetch
  // after an update). Adjusted during render — React's recommended pattern.
  const [synced, setSynced] = useState({ checkInInterval, gracePeriod, contestableWindow });
  if (
    !isSubmitting &&
    (synced.checkInInterval !== checkInInterval ||
      synced.gracePeriod !== gracePeriod ||
      synced.contestableWindow !== contestableWindow)
  ) {
    setSynced({ checkInInterval, gracePeriod, contestableWindow });
    setValues(fromChain(checkInInterval, gracePeriod, contestableWindow));
  }

  const isGreen = vaultStatus === VaultStatus.Green;
  const disabled = !isGreen || isSubmitting || isLoading;

  const seconds = {
    interval: toSeconds(values.interval),
    grace: toSeconds(values.grace),
    veto: toSeconds(values.veto),
  };
  const allValid = FIELDS.every((f) => Number.isFinite(seconds[f.key]) && seconds[f.key] >= f.min);
  const isDirty =
    seconds.interval !== Number(checkInInterval) ||
    seconds.grace !== Number(gracePeriod) ||
    seconds.veto !== Number(contestableWindow);
  const activePreset = PRESETS.find((p) => FIELDS.every((f) => p.seconds[f.key] === seconds[f.key]))?.id ?? "custom";

  const setField = (key: FieldKey, patch: Partial<Duration>) => {
    setMessage(null);
    setValues((v) => ({ ...v, [key]: { ...v[key], ...patch } }));
  };

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setMessage(null);
    setValues({
      interval: toDuration(preset.seconds.interval),
      grace: toDuration(preset.seconds.grace),
      veto: toDuration(preset.seconds.veto),
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const invalid = FIELDS.find((f) => !Number.isFinite(seconds[f.key]) || seconds[f.key] < f.min);
    if (invalid) {
      setMessage({
        text: invalid.min > 0 ? `${invalid.label} must be at least ${humanDuration(invalid.min)}.` : `Enter a valid ${invalid.label.toLowerCase()}.`,
        isError: true,
      });
      return;
    }

    try {
      setIsSubmitting(true);
      setMessage(null);
      await onUpdateParameters(BigInt(seconds.interval), BigInt(seconds.grace), BigInt(seconds.veto));
      setMessage({ text: "Timing saved.", isError: false });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Couldn't save timing.";
      setMessage({ text: msg, isError: true });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="panel-stack">
      <div className="panel-head">
        <div>
          <h3 className="panel-title">Timing</h3>
          <p className="panel-lead">How long each stage lasts before your heirs can inherit.</p>
        </div>
        {isGreen ? (
          <div className="segmented" role="group" aria-label="Presets">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" aria-pressed={activePreset === p.id} onClick={() => applyPreset(p)} disabled={disabled}>
                {p.label}
              </button>
            ))}
            <button type="button" aria-pressed={activePreset === "custom"} disabled tabIndex={-1}>
              Custom
            </button>
          </div>
        ) : (
          <span className="lock-note">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            Check in to make changes
          </span>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 28,
          flexWrap: "wrap",
          padding: "18px 20px",
          borderRadius: 0,
          border: "1px solid rgba(255, 255, 255, 0.08)",
          background: "rgba(255, 255, 255, 0.02)",
        }}
      >
        <TimingClockPreview
          intervalSec={safeSeconds(seconds.interval)}
          graceSec={safeSeconds(seconds.grace)}
          vetoSec={safeSeconds(seconds.veto)}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: "1 1 200px", minWidth: 180 }}>
          <ClockLegendRow color="var(--status-green)" label="Checking in" value={allValid ? humanDuration(seconds.interval) : "—"} />
          <ClockLegendRow color="var(--status-amber)" label="Grace period" value={allValid ? humanDuration(seconds.grace) : "—"} />
          <ClockLegendRow color="var(--status-red)" label="Veto window" value={allValid ? humanDuration(seconds.veto) : "—"} />
        </div>
      </div>

      <div className="setting-list">
        {FIELDS.map((f) => (
          <div key={f.key} className="setting-row">
            <div className="setting-label">
              <strong>{f.label}</strong>
              <span>{f.hint}</span>
            </div>
            <div className="setting-control">
              <DurationDial
                seconds={seconds[f.key]}
                min={f.min}
                max={DIAL_MAX_SECONDS}
                color={FIELD_COLOR[f.key]}
                label={f.label}
                disabled={disabled}
                onChange={(s) => setField(f.key, toDuration(s))}
              />
            </div>
          </div>
        ))}
      </div>

      {allValid && (
        <p className="panel-summary" style={{ margin: 0 }}>
          If you stop checking in, your heirs can start a claim after <strong>{humanDuration(seconds.interval + seconds.grace)}</strong>.
          You&apos;ll then have <strong>{humanDuration(seconds.veto)}</strong> to cancel it.
        </p>
      )}

      {message && <div className={`panel-note ${message.isError ? "panel-note--error" : "panel-note--success"}`}>{message.text}</div>}

      {isGreen && (
        <div className="panel-actions">
          {isDirty && (
            <button
              type="button"
              className="flow-btn flow-btn--ghost"
              onClick={() => {
                setMessage(null);
                setValues(fromChain(checkInInterval, gracePeriod, contestableWindow));
              }}
              disabled={isSubmitting}
            >
              Reset
            </button>
          )}
          <button type="submit" className="flow-btn" disabled={!isDirty || isSubmitting || isLoading}>
            {isSubmitting ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
    </form>
  );
}
