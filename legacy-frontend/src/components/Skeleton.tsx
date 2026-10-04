"use client";

import React from "react";

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  variant?: "default" | "brass" | "subtle" | "dark";
  className?: string;
  style?: React.CSSProperties;
}

export function Skeleton({
  width = "100%",
  height = "16px",
  borderRadius = "2px",
  variant = "default",
  className = "",
  style = {},
}: SkeletonProps) {
  const shimmerClass =
    variant === "brass"
      ? "skeleton-shimmer-brass"
      : variant === "subtle"
      ? "skeleton-pulse"
      : "skeleton-shimmer";

  const baseBg =
    variant === "brass"
      ? "rgba(184, 137, 74, 0.08)"
      : variant === "dark"
      ? "rgba(255, 255, 255, 0.02)"
      : "rgba(255, 255, 255, 0.05)";

  return (
    <div
      className={`skeleton-box ${shimmerClass} ${className}`}
      style={{
        width,
        height,
        borderRadius,
        backgroundColor: baseBg,
        border: "1px solid rgba(255, 255, 255, 0.05)",
        ...style,
      }}
      aria-hidden="true"
    />
  );
}

export function SkeletonText({
  lines = 3,
  gap = "8px",
  lastLineWidth = "60%",
  lineHeight = "14px",
  style = {},
}: {
  lines?: number;
  gap?: string | number;
  lastLineWidth?: string;
  lineHeight?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap, width: "100%", ...style }}>
      {Array.from({ length: lines }).map((_, i) => {
        const isLast = i === lines - 1;
        return (
          <Skeleton
            key={i}
            height={lineHeight}
            width={isLast ? lastLineWidth : `${90 + (i % 3) * 4}%`}
          />
        );
      })}
    </div>
  );
}

export function SkeletonBadge({
  width = "100px",
  height = "22px",
  style = {},
}: {
  width?: string | number;
  height?: string | number;
  style?: React.CSSProperties;
}) {
  return (
    <Skeleton
      width={width}
      height={height}
      borderRadius="4px"
      style={{ border: "1px solid rgba(255, 255, 255, 0.08)", ...style }}
    />
  );
}

export function SkeletonButton({
  width = "140px",
  height = "40px",
  variant = "secondary",
  style = {},
}: {
  width?: string | number;
  height?: string | number;
  variant?: "primary" | "secondary" | "brass";
  style?: React.CSSProperties;
}) {
  return (
    <Skeleton
      width={width}
      height={height}
      variant={variant === "brass" || variant === "primary" ? "brass" : "default"}
      borderRadius="0px"
      style={{
        border:
          variant === "brass" || variant === "primary"
            ? "1px solid var(--accent-brass)"
            : "1px solid rgba(255, 255, 255, 0.15)",
        ...style,
      }}
    />
  );
}

/* ─── Liveness Panel Skeleton (big circular dial) ────────────────── */
export function LivenessPanelSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "20px", padding: "12px 0 8px" }}>
      <div
        className="skeleton-shimmer-brass"
        style={{
          width: 160,
          height: 160,
          borderRadius: "50%",
          border: "3px solid rgba(184, 137, 74, 0.25)",
        }}
      />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" }}>
        <Skeleton width="120px" height="24px" variant="brass" />
        <Skeleton width="160px" height="20px" />
        <Skeleton width="140px" height="12px" />
      </div>
      <SkeletonButton width="220px" height="44px" variant="brass" />
    </div>
  );
}

/* ─── Complete Vault Dashboard Skeleton ──────────────────────────── */
export function VaultDashboardSkeleton({ message = "CONNECTING TO WORLD CHAIN" }: { message?: string }) {
  return (
    <div
      className="landing-canvas animate-fade-up"
      style={{
        minHeight: "calc(100vh - var(--header-height, 64px))",
        padding: "32px 24px 96px",
      }}
    >
      <div style={{ maxWidth: "1600px", margin: "0 auto", width: "100%" }}>
        {/* Subtle Cryptographic Telemetry Bar */}
        <div
          style={{
            marginBottom: "16px",
            padding: "8px 16px",
            backgroundColor: "rgba(184, 137, 74, 0.05)",
            border: "1px solid rgba(184, 137, 74, 0.2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: "0.75rem",
            fontFamily: "var(--font-data)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                backgroundColor: "var(--accent-brass)",
                boxShadow: "0 0 8px var(--accent-brass)",
                display: "inline-block",
                animation: "pulse-glow 1.5s infinite",
              }}
            />
            <span style={{ color: "var(--accent-brass)", letterSpacing: "0.04em" }}>
              {message}…
            </span>
          </div>
          <span style={{ color: "rgba(255, 255, 255, 0.4)" }}>
            WORLD CHAIN SEPOLIA
          </span>
        </div>

        {/* Dashboard Hub Skeleton — matches what actually loads next:
            the CTA header + "Your Vaults" / "Beneficiary Of" card grids. */}
        <div className="panel-instrument" style={{ background: "#000000", border: "1px solid rgba(255, 255, 255, 0.15)" }}>
          <div style={{ padding: "32px", display: "flex", flexDirection: "column", gap: "40px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "16px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <Skeleton width="220px" height="26px" variant="brass" />
                <Skeleton width="320px" height="14px" />
              </div>
              <SkeletonButton width="180px" height="44px" variant="brass" />
            </div>

            {[{ w: "140px" }, { w: "220px" }].map((section, si) => (
              <div key={si} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <Skeleton width={section.w} height="12px" />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "14px" }}>
                  {[1, 2].map((i) => (
                    <div key={i} style={{ display: "flex", flexDirection: "column", gap: 10, padding: "18px 20px", border: "1px solid rgba(255, 255, 255, 0.08)" }}>
                      <Skeleton width="60px" height="12px" />
                      <Skeleton width="70%" height="16px" />
                      <Skeleton width="40%" height="12px" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Transparency Lookup Skeleton ───────────────────────────────── */
export function TransparencyLookupSkeleton({ queriedAddress }: { queriedAddress?: string | null }) {
  return (
    <div className="animate-fade-up" style={{ padding: "36px 32px", display: "flex", flexDirection: "column", gap: "28px" }}>
      {/* Target query telemetry */}
      <div
        style={{
          padding: "12px 18px",
          backgroundColor: "rgba(184, 137, 74, 0.06)",
          border: "1px solid rgba(184, 137, 74, 0.3)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontFamily: "var(--font-data)",
          fontSize: "0.8125rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              backgroundColor: "var(--accent-brass)",
              boxShadow: "0 0 8px var(--accent-brass)",
              animation: "pulse-glow 1.5s infinite",
            }}
          />
          <span style={{ color: "var(--accent-brass)" }}>
            CONNECTING TO WORLD CHAIN
            {queriedAddress ? ` · ${queriedAddress.slice(0, 10)}…${queriedAddress.slice(-8)}` : ""}
          </span>
        </div>
        <span style={{ color: "rgba(255, 255, 255, 0.4)" }}>SYNCING CONTRACT STATE</span>
      </div>

      {/* Primary Status Banner Skeleton */}
      <div
        style={{
          padding: "24px 28px",
          backgroundColor: "rgba(255, 255, 255, 0.02)",
          border: "1px solid rgba(255, 255, 255, 0.1)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <Skeleton width="48px" height="48px" borderRadius="50%" variant="brass" />
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <Skeleton width="220px" height="20px" variant="brass" />
            <Skeleton width="180px" height="13px" />
          </div>
        </div>
        <SkeletonBadge width="140px" height="32px" />
      </div>

      {/* 4-Metric Grid Skeleton */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "16px",
        }}
      >
        {[
          "Owner Identity",
          "World ID Proof Binding",
          "Designated Beneficiaries",
          "Last Biometric Check-in",
        ].map((title, i) => (
          <div
            key={i}
            style={{
              padding: "20px",
              backgroundColor: "rgba(255, 255, 255, 0.02)",
              border: "1px solid rgba(255, 255, 255, 0.08)",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            <span className="label-overline">{title}</span>
            <Skeleton width="140px" height="22px" variant={i === 1 ? "brass" : "default"} />
            <Skeleton width="90px" height="11px" />
          </div>
        ))}
      </div>

      {/* Timelock Parameters Table Skeleton */}
      <div
        style={{
          border: "1px solid rgba(255, 255, 255, 0.08)",
          backgroundColor: "rgba(255, 255, 255, 0.01)",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <Skeleton width="180px" height="16px" variant="brass" />
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {[1, 2, 3].map((row) => (
            <div
              key={row}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "8px 0",
                borderBottom: "1px solid rgba(255, 255, 255, 0.05)",
              }}
            >
              <Skeleton width="140px" height="14px" />
              <Skeleton width="80px" height="14px" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Claim Portal Skeleton ──────────────────────────────────────── */
export function ClaimPortalSkeleton() {
  return (
    <div
      className="landing-canvas animate-fade-up"
      style={{
        minHeight: "calc(100vh - var(--header-height, 64px))",
        padding: "40px 24px 96px",
      }}
    >
      <div className="app-container">
        {/* Navigation Breadcrumb Skeleton */}
        <div style={{ marginBottom: "24px", display: "flex", alignItems: "center", gap: "12px" }}>
          <Skeleton width="70px" height="30px" />
          <Skeleton width="180px" height="14px" variant="brass" />
        </div>

        {/* Primary Instrument Box Skeleton */}
        <div className="panel-instrument" style={{ background: "#000000", border: "1px solid rgba(255, 255, 255, 0.2)" }}>
          {/* Header */}
          <div style={{ padding: "36px 32px 28px", borderBottom: "1px solid rgba(255, 255, 255, 0.12)" }}>
            <Skeleton width="340px" height="36px" variant="brass" style={{ marginBottom: "14px" }} />
            <SkeletonText lines={2} lineHeight="14px" lastLineWidth="70%" />
          </div>

          {/* Search Box Skeleton */}
          <div style={{ padding: "28px 32px", borderBottom: "1px solid rgba(255, 255, 255, 0.12)", background: "rgba(255, 255, 255, 0.02)" }}>
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
              <Skeleton width="360px" height="44px" />
              <SkeletonButton width="160px" height="44px" variant="brass" />
            </div>
          </div>

          {/* Body Skeleton */}
          <div style={{ padding: "40px 32px", display: "flex", flexDirection: "column", gap: "24px" }}>
            <div
              style={{
                padding: "24px",
                backgroundColor: "rgba(255, 255, 255, 0.02)",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                display: "flex",
                flexDirection: "column",
                gap: "16px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Skeleton width="180px" height="20px" variant="brass" />
                <SkeletonBadge width="120px" height="24px" />
              </div>
              <SkeletonText lines={3} lineHeight="14px" />
              <SkeletonButton width="220px" height="42px" variant="brass" style={{ marginTop: "8px" }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Home Hero Skeleton ─────────────────────────────────────────── */
export function HomeHeroSkeleton() {
  return (
    <div className="landing-canvas animate-fade-up">
      <section className="hero-content-wrap" aria-hidden="true">
        {/* Giant Title Lines Skeleton */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: "24px" }}>
          <Skeleton width="70%" height="56px" variant="brass" />
          <Skeleton width="85%" height="56px" />
          <Skeleton width="60%" height="56px" />
        </div>

        {/* Subtitle */}
        <Skeleton width="340px" height="18px" style={{ marginBottom: "32px" }} />

        {/* Buttons */}
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", marginTop: "32px" }}>
          <SkeletonButton width="240px" height="48px" variant="brass" />
          <SkeletonButton width="180px" height="48px" variant="secondary" />
        </div>

        {/* Telemetry Strip Skeleton */}
        <div className="hero-telemetry-strip" style={{ marginTop: "48px" }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="telemetry-cell">
              <Skeleton width="110px" height="11px" />
              <Skeleton width="160px" height="16px" variant={i === 1 ? "brass" : "default"} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
