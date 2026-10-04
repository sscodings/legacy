"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAccount, useChainId, useSwitchChain, useReadContract } from "wagmi";
import { useWalletModal } from "./WalletModal";
import { worldChainSepolia, CONTRACT_ADDRESSES } from "@/lib/constants";
import { LegacyVaultFactoryABI } from "@/lib/contracts/abis";

export function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { openConnectModal, openAccountModal } = useWalletModal();

  const isLanding = pathname === "/";
  const isWrongChain = isConnected && chainId !== worldChainSepolia.id;

  // Read whether the connected wallet already has deployed vaults
  const { data: userVaults } = useReadContract({
    address: CONTRACT_ADDRESSES.factory,
    abi: LegacyVaultFactoryABI,
    functionName: "getVaults",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });
  const hasVaults = Boolean(userVaults && userVaults.length > 0);

  useEffect(() => {
    // Delay slightly to prevent hydration mismatch while avoiding synchronous setState in effect
    const t = setTimeout(() => setMounted(true), 0);
    return () => clearTimeout(t);
  }, []);

  const scrollToSection = (id: string) => {
    const targetId = id === "architecture" ? "specs" : id;
    if (pathname === "/") {
      const el =
        document.getElementById(targetId) ||
        document.getElementById(id) ||
        (targetId === "specs" ? document.getElementById("architecture") : null);
      if (el) {
        const yOffset = -80;
        const y = el.getBoundingClientRect().top + window.pageYOffset + yOffset;
        window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
        try {
          window.history.replaceState(null, "", `#${targetId}`);
        } catch {}
        return;
      }
    }
    router.push(`/#${targetId}`);
  };

  const navItemStyle = (isActive: boolean) => ({
    fontFamily: "'Murs Gothic', var(--font-murs-gothic), sans-serif",
    fontSize: "0.8125rem",
    fontWeight: 800,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    textDecoration: "none",
    padding: "8px 14px",
    color: isActive ? "#ffffff" : "var(--text-secondary)",
    backgroundColor: isActive ? "rgba(255, 255, 255, 0.08)" : "transparent",
    borderBottom: isActive ? "2px solid var(--accent-brass)" : "2px solid transparent",
    transition: "all 0.15s ease",
    cursor: "pointer",
    borderLeft: "none",
    borderRight: "none",
    borderTop: "none",
    alignItems: "center",
  });

  return (
    <header
      className="header-shell"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        background: "rgba(0, 0, 0, 0.90)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderBottom: "1px solid rgba(255, 255, 255, 0.12)",
        height: "68px",
        width: "100%",
      }}
      role="banner"
    >
      <div
        className="header-inner"
        style={{
          maxWidth: "1400px",
          height: "100%",
          padding: "0 32px",
          margin: "0 auto",
          gap: "20px",
        }}
      >
        {/* Brand */}
        <div className="header-brand">
          <Link
            href="/"
            className="brand-link"
            style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: "10px" }}
            aria-label="Legacy Home"
          >
            <span
              style={{
                fontFamily: "'Murs Gothic', var(--font-murs-gothic), sans-serif",
                fontSize: "1.125rem",
                fontWeight: 900,
                letterSpacing: "0.08em",
                color: "#ffffff",
                textTransform: "uppercase",
              }}
            >
              LEGACY
            </span>
          </Link>
        </div>

        {/* Conditional Navigation Links (centered column) */}
        <nav className="header-nav" aria-label="Primary navigation">
          {isLanding ? (
            /* Landing Page Navigation Links */
            <>
              <button
                type="button"
                onClick={() => scrollToSection("lifecycle")}
                style={navItemStyle(false)}
                className="header-nav-btn"
              >
                HOW IT WORKS
              </button>
              <button
                type="button"
                onClick={() => scrollToSection("specs")}
                style={navItemStyle(false)}
                className="header-nav-btn"
              >
                WHY IT&apos;S SAFE
              </button>
              <button
                type="button"
                onClick={() => scrollToSection("get-started")}
                style={navItemStyle(false)}
                className="header-nav-btn"
              >
                GET STARTED
              </button>
            </>
          ) : (
            /* Separate Pages Navigation Links */
            <>
              <Link
                href="/vault"
                style={navItemStyle(pathname.startsWith("/vault"))}
                aria-current={pathname.startsWith("/vault") ? "page" : undefined}
                id="nav-link-vault"
              >
                DASHBOARD
              </Link>
              <Link
                href="/claim"
                style={navItemStyle(pathname === "/claim")}
                aria-current={pathname === "/claim" ? "page" : undefined}
                id="nav-link-claim"
              >
                HEIR PORTAL
              </Link>
              <Link
                href="/lookup"
                style={navItemStyle(pathname === "/lookup")}
                aria-current={pathname === "/lookup" ? "page" : undefined}
                id="nav-link-lookup"
              >
                LOOKUP
              </Link>
            </>
          )}
        </nav>

        {/* Wallet & Contextual Actions Area */}
        <div className="header-wallet" style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div
            className="wallet-area"
            style={!mounted ? { opacity: 0, pointerEvents: "none", userSelect: "none" } : undefined}
          >
            {!isConnected ? (
              /* Not Connected State: Conditional CTA + Select Wallet */
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                {isLanding && (
                  <Link
                    href="/vault"
                    className="btn-secondary header-launch-btn"
                    style={{
                      padding: "8px 16px",
                      fontSize: "0.75rem",
                      borderRadius: 0,
                      borderColor: "rgba(255, 255, 255, 0.2)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                    id="header-launch-vault-btn"
                  >
                    <span>LAUNCH VAULT</span>
                    <span>→</span>
                  </Link>
                )}

                <button
                  onClick={openConnectModal}
                  type="button"
                  className="btn-select-wallet"
                  id="connect-wallet-btn"
                  style={{ padding: "8px 20px", fontSize: "0.75rem" }}
                >
                  CONNECT WALLET
                </button>
              </div>
            ) : isWrongChain ? (
              /* Wrong Network State */
              <button
                onClick={() => switchChain?.({ chainId: worldChainSepolia.id })}
                type="button"
                className="btn-chain-wrong"
                id="switch-chain-btn"
                title="Click to switch to World Chain Sepolia"
              >
                Wrong Network
              </button>
            ) : (
              /* Connected State */
              <div className="wallet-connected" style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                {/* On landing page: offer direct quick-jump button into the user's vault */}
                {isLanding && (
                  <Link
                    href="/vault"
                    className="btn-hero-action"
                    style={{
                      marginTop: 0,
                      padding: "8px 16px",
                      fontSize: "0.75rem",
                      backgroundColor: "var(--accent-brass)",
                      color: "#10151A",
                      borderColor: "var(--accent-brass)",
                      textDecoration: "none",
                    }}
                    id="header-open-vault-btn"
                  >
                    <span>{hasVaults ? "OPEN VAULT" : "CREATE VAULT"}</span>
                    <span className="arrow-icon" aria-hidden="true">→</span>
                  </Link>
                )}

                {/* Account pill with truncated address */}
                <button
                  onClick={openAccountModal}
                  type="button"
                  className="account-pill"
                  id="account-modal-btn"
                  title="View account details"
                  style={{
                    borderRadius: 0,
                    backgroundColor: "rgba(255, 255, 255, 0.05)",
                    border: "1px solid rgba(255, 255, 255, 0.15)",
                    padding: "6px 12px",
                  }}
                >
                  <span className="font-data" style={{ fontSize: "0.8125rem", color: "#ffffff" }}>
                    {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : ""}
                  </span>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
