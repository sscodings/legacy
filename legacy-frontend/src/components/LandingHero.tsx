"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useWalletModal } from "@/components/WalletModal";
import { CONTRACT_ADDRESSES } from "@/lib/constants";

const HERO_FACTS = [
  { value: "1 SCAN", label: "World ID proves you're alive" },
  { value: "0 CUSTODIANS", label: "Nobody else holds your assets" },
  { value: "100% ON-CHAIN", label: "Rules enforced by smart contracts" },
];

const LIFECYCLE_STEPS = [
  {
    tone: "green",
    name: "YOU'RE ACTIVE",
    desc: "Check in with World ID on your own schedule. Everything stays yours.",
    next: "Each check-in resets the clock",
  },
  {
    tone: "amber",
    name: "GRACE PERIOD",
    desc: "Missed a check-in? You get a buffer before anything happens.",
    next: "One check-in turns it green again",
  },
  {
    tone: "red",
    name: "HEIRS CAN CLAIM",
    desc: "Your heirs can open a claim, but it waits out a veto window first.",
    next: "Still alive? Check in to cancel it",
  },
] as const;

const iconProps = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const SAFETY_FEATURES = [
  {
    title: "PRIVATE PROOF OF LIFE",
    desc: "World ID confirms you're a real, living person without revealing who you are.",
    icon: (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="9" />
        <path d="M8.5 12.5l2.5 2.5 4.5-5" />
      </svg>
    ),
  },
  {
    title: "YOUR OWN VAULT",
    desc: "Every vault is its own contract. Nothing is pooled and nothing can be upgraded.",
    icon: (
      <svg {...iconProps}>
        <rect x="4" y="10" width="16" height="10" rx="1" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </svg>
    ),
  },
  {
    title: "BUILT-IN VETO",
    desc: "Every claim waits out a window. One check-in from you blocks it.",
    icon: (
      <svg {...iconProps}>
        <path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6l8-3z" />
        <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
      </svg>
    ),
  },
  {
    title: "PICK WHO GETS WHAT",
    desc: "Send each token, NFT, or ENS name to the specific heir you choose.",
    icon: (
      <svg {...iconProps}>
        <path d="M12 20v-6M12 14L6 8M12 14l6-6" />
        <circle cx="6" cy="6" r="2" />
        <circle cx="18" cy="6" r="2" />
      </svg>
    ),
  },
];

interface LandingHeroProps {
  onOpenVault?: () => void;
  hasVaults?: boolean;
}



// Fades a section in once it scrolls into view, with an optional per-item
// stagger delay — used for the lifecycle/architecture card grids so they
// don't just materialize fully-formed on load.
function useInView<T extends HTMLElement>(threshold = 0.2) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold]);

  return [ref, inView] as const;
}

function RevealCard({
  index = 0,
  className = "",
  style,
  children,
}: {
  index?: number;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const delay = Math.min(index, 6) * 90;

  return (
    <div
      ref={ref}
      className={`reveal-card${inView ? " reveal-card--visible" : ""}${className ? ` ${className}` : ""}`}
      style={{ ...style, transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

export function LandingHero({ onOpenVault, hasVaults = false }: LandingHeroProps) {
  const { isConnected } = useAccount();
  const { openConnectModal } = useWalletModal();

  const handlePrimaryAction = () => {
    if (isConnected && onOpenVault) {
      onOpenVault();
    } else {
      openConnectModal();
    }
  };

  useEffect(() => {
    const handleHashScroll = () => {
      const hash = window.location.hash.replace("#", "");
      if (!hash) return;
      const targetId = hash === "architecture" ? "specs" : hash;
      const el = document.getElementById(targetId) || document.getElementById(hash);
      if (el) {
        setTimeout(() => {
          const y = el.getBoundingClientRect().top + window.pageYOffset - 80;
          window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
        }, 120);
      }
    };

    handleHashScroll();
    window.addEventListener("hashchange", handleHashScroll);
    return () => window.removeEventListener("hashchange", handleHashScroll);
  }, []);


  return (
    <div className="landing-canvas">
      {/* ── Hero Main Content ────────────────────────────────── */}
      <section className="hero-content-wrap" aria-label="Legacy introduction">
        {/* Giant Stacked Title in Murs Gothic */}
        <h1 className="hero-giant-title animate-fade-up" style={{ animationDelay: "0ms" }}>
          <span>AUTONOMOUS</span>
          <span>SUCCESSION</span>
          <span className="text-stroke-white">DIGITAL</span>
          <span className="text-stroke-white">LEGACY</span>
        </h1>

        {/* Subtitle */}
        <p className="hero-subtitle animate-fade-up" style={{ animationDelay: "90ms" }}>
          Your crypto goes to the people you choose, automatically, if you ever stop checking in.
        </p>

        {/* Action Buttons */}
        <div
          className="animate-fade-up"
          style={{ display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap", marginTop: "32px", animationDelay: "160ms" }}
        >
          <button
            type="button"
            onClick={handlePrimaryAction}
            className="btn-hero-action"
            id="hero-launch-vault-btn"
            style={{ marginTop: 0 }}
          >
            <span>{isConnected ? (hasVaults ? "OPEN MY VAULT" : "CREATE MY VAULT") : "GET STARTED"}</span>
            <span className="arrow-icon" aria-hidden="true">→</span>
          </button>

          <Link href="/claim" className="btn-hero-action btn-hero-action--ghost" style={{ marginTop: 0 }}>
            <span>I&apos;M AN HEIR</span>
            <span className="arrow-icon" aria-hidden="true">↗</span>
          </Link>
        </div>

        {/* At-a-glance facts */}
        <dl
          className="hero-facts animate-fade-up"
          aria-label="Legacy at a glance"
          style={{ animationDelay: "230ms" }}
        >
          {HERO_FACTS.map((fact) => (
            <div key={fact.label} className="hero-fact">
              <dt className="hero-fact-value">{fact.value}</dt>
              <dd className="hero-fact-label">{fact.label}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ── Section 1: How it works ──────────────────────────── */}
      <section id="lifecycle" className="landing-section-wrap" aria-labelledby="lifecycle-title">
        <div className="landing-section-header">
          <span className="section-tag">[ 01 // HOW IT WORKS ]</span>
          <h2 id="lifecycle-title" className="section-title">
            THREE STATES. ONE RULE.
          </h2>
          <p className="section-lead">Keep checking in and nothing changes. Stop, and your heirs take over.</p>
        </div>

        <ol className="lifecycle-grid">
          {LIFECYCLE_STEPS.map((step, i) => (
            <li key={step.name} style={{ listStyle: "none", display: "flex" }}>
              <RevealCard index={i} className={`lifecycle-card lifecycle-card--${step.tone}`}>
                <div className="lifecycle-card-top">
                  <span className="lifecycle-badge" style={{ color: `var(--status-${step.tone})` }}>
                    <span className="network-dot" style={{ backgroundColor: `var(--status-${step.tone})` }} />
                    {step.tone}
                  </span>
                  <span className="lifecycle-stage-num">0{i + 1}</span>
                </div>
                <h3 className="lifecycle-name">{step.name}</h3>
                <p className="lifecycle-desc">{step.desc}</p>
                <div className="lifecycle-mechanic">{step.next}</div>
              </RevealCard>
            </li>
          ))}
        </ol>
      </section>

      {/* ── Section 2: Why it's safe ─────────────────────────── */}
      <section id="specs" className="landing-section-wrap" aria-labelledby="arch-title" style={{ paddingTop: 0 }}>
        <span id="architecture" style={{ display: "block", position: "relative", top: "-80px", visibility: "hidden" }} />
        <div className="landing-section-header">
          <span className="section-tag">[ 02 // WHY IT&apos;S SAFE ]</span>
          <h2 id="arch-title" className="section-title">
            NO MIDDLEMEN. NO SURPRISES.
          </h2>
          <p className="section-lead">Smart contracts on World Chain enforce every rule. No lawyers, custodians, or multisigs.</p>
        </div>

        <div className="arch-grid">
          {SAFETY_FEATURES.map((feature, i) => (
            <RevealCard key={feature.title} index={i} className="arch-card">
              <span className="arch-card-icon" aria-hidden="true">
                {feature.icon}
              </span>
              <h3 className="arch-card-title">{feature.title}</h3>
              <p className="arch-card-desc">{feature.desc}</p>
            </RevealCard>
          ))}
        </div>

        {/* ── Call to Action Banner ── */}
        <div id="get-started" className="landing-cta-banner">
          <div className="cta-banner-content">
            <span className="section-tag">[ GET STARTED ]</span>
            <h3 className="cta-banner-title">SET UP IN A MINUTE</h3>
            <p className="cta-banner-desc">Pick a check-in schedule, add your heirs, and you&apos;re done.</p>
          </div>
          <div className="cta-banner-actions">
            <button type="button" onClick={handlePrimaryAction} className="btn-hero-action" style={{ marginTop: 0 }}>
              <span>{isConnected ? (hasVaults ? "OPEN MY VAULT" : "CREATE MY VAULT") : "CONNECT WALLET"}</span>
              <span className="arrow-icon" aria-hidden="true">→</span>
            </button>
            <Link href="/claim" className="btn-hero-action btn-hero-action--ghost" style={{ marginTop: 0 }}>
              <span>I&apos;M AN HEIR</span>
              <span className="arrow-icon" aria-hidden="true">↗</span>
            </Link>
          </div>
        </div>
      </section>

      {/* ── Minimal Footer ───────────────────────────────────── */}
      <footer className="landing-footer-shell" role="contentinfo">
        <div className="landing-footer-inner">
          <div>
            <span style={{ fontWeight: 800, color: "#ffffff", letterSpacing: "0.06em" }}>LEGACY PROTOCOL</span>
            <span style={{ margin: "0 10px" }}>·</span>
            <span>WORLD CHAIN SEPOLIA (CHAIN ID 4801)</span>
          </div>

          <div className="landing-footer-links">
            <button
              type="button"
              onClick={handlePrimaryAction}
              style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", font: "inherit", padding: 0 }}
            >
              Vault
            </button>
            <Link href="/claim">Heir Portal</Link>
            <Link href="/lookup">Lookup</Link>
            <a
              href={`https://sepolia.worldscan.org/address/${CONTRACT_ADDRESSES.factory}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Factory Contract ↗
            </a>
            <a
              href={`https://sepolia.worldscan.org/address/${CONTRACT_ADDRESSES.verifier}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Verifier Contract ↗
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
