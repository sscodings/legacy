"use client";

import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { useDialogBehavior } from "@/hooks/useDialogBehavior";
import { useAccount, useConnect, useDisconnect, useSwitchChain, useChainId } from "wagmi";
import { worldChainSepolia } from "@/lib/constants";

import { appKit } from "@/lib/reown";

interface WalletModalContextType {
  openConnectModal: () => void;
  closeConnectModal: () => void;
  openAccountModal: () => void;
  closeAccountModal: () => void;
}

const WalletModalContext = createContext<WalletModalContextType>({
  openConnectModal: () => {},
  closeConnectModal: () => {},
  openAccountModal: () => {},
  closeAccountModal: () => {},
});

export function useWalletModal() {
  return useContext(WalletModalContext);
}

export function WalletModalProvider({ children }: { children: ReactNode }) {
  const [isConnectOpen, setIsConnectOpen] = useState(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [pendingConnectorId, setPendingConnectorId] = useState<string | null>(null);

  const { address, isConnected, connector: activeConnector } = useAccount();
  const { connectors, connectAsync, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const chainId = useChainId();

  // Close connect modal once connected
  useEffect(() => {
    if (isConnected) {
      const t = setTimeout(() => setIsConnectOpen(false), 0);
      return () => clearTimeout(t);
    }
  }, [isConnected]);

  // Escape, scroll lock, focus trap and focus restore for each dialog
  const connectDialogRef = useDialogBehavior<HTMLDivElement>(isConnectOpen, () => setIsConnectOpen(false));
  const accountDialogRef = useDialogBehavior<HTMLDivElement>(isAccountOpen && Boolean(address), () => setIsAccountOpen(false));

  const handleConnect = async (connectorId: string) => {
    setErrorMessage(null);
    setPendingConnectorId(connectorId);
    console.log("👉 [WalletModal] Connecting to wallet with connector:", connectorId);
    try {
      const targetConnector = connectors.find((c) => c.id === connectorId) || connectors[0];
      if (!targetConnector) {
        throw new Error("Connector not available");
      }
      await connectAsync({ connector: targetConnector });
      console.log("✅ [WalletModal] Wallet connected successfully:", connectorId);
      setIsConnectOpen(false);
    } catch (err: unknown) {
      console.error("❌ [WalletModal] Connection error:", err);
      const msg = err instanceof Error ? err.message : "Failed to connect wallet";
      if (msg.includes("User rejected") || msg.includes("4001") || msg.includes("rejected")) {
        setErrorMessage("Connection rejected in wallet.");
      } else {
        setErrorMessage(msg);
      }
    } finally {
      setPendingConnectorId(null);
    }
  };

  const handleCopy = () => {
    if (address) {
      navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDisconnect = () => {
    disconnect();
    setIsAccountOpen(false);
  };

  return (
    <WalletModalContext.Provider
      value={{
        openConnectModal: () => {
          try {
            appKit?.open?.({ view: "Connect" });
          } catch {
            setErrorMessage(null);
            setIsConnectOpen(true);
          }
        },
        closeConnectModal: () => {
          try {
            appKit?.close?.();
          } catch {
            setIsConnectOpen(false);
          }
        },
        openAccountModal: () => {
          try {
            appKit?.open?.({ view: "Account" });
          } catch {
            setIsAccountOpen(true);
          }
        },
        closeAccountModal: () => {
          try {
            appKit?.close?.();
          } catch {
            setIsAccountOpen(false);
          }
        },
      }}
    >
      {children}

      {/* ─── Connect Wallet Modal ─── */}
      {isConnectOpen && (
        <div
          ref={connectDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="connect-modal-title"
          className="modal-backdrop-animate"
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(16, 21, 26, 0.85)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "16px",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsConnectOpen(false);
          }}
        >
          <div
            className="panel-elevated modal-surface-animate"
            style={{
              width: "100%",
              maxWidth: "440px",
              padding: "28px",
              display: "flex",
              flexDirection: "column",
              gap: "20px",
            }}
          >
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <h2
                  id="connect-modal-title"
                  className="font-display"
                  style={{ fontSize: "1.5rem", color: "var(--text-primary)" }}
                >
                  Connect Wallet
                </h2>
                <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginTop: "4px" }}>
                  World Chain Sepolia · Powered by MetaMask Connect
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsConnectOpen(false)}
                className="btn-secondary"
                style={{ padding: "4px 8px", fontSize: "0.8125rem" }}
                aria-label="Close dialog"
              >
                ✕
              </button>
            </div>

            {/* Error banner */}
            {errorMessage && (
              <div
                style={{
                  padding: "10px 14px",
                  backgroundColor: "rgba(193, 80, 63, 0.12)",
                  border: "1px solid var(--status-red)",
                  borderRadius: 0,
                  fontSize: "0.8125rem",
                  color: "var(--text-primary)",
                }}
              >
                {errorMessage}
              </div>
            )}

            {/* Connector options */}
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {/* MetaMask Option (metaMaskSDK) */}
              <button
                type="button"
                onClick={() => handleConnect("metaMaskSDK")}
                disabled={isPending}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "14px 16px",
                  backgroundColor: "var(--bg-base)",
                  border: "1px solid var(--border-hairline)",
                  borderRadius: 0,
                  color: "var(--text-primary)",
                  cursor: isPending ? "wait" : "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--accent-brass)";
                  e.currentTarget.style.backgroundColor = "var(--bg-surface)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--border-hairline)";
                  e.currentTarget.style.backgroundColor = "var(--bg-base)";
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  {/* MetaMask Fox SVG */}
                  <svg width="28" height="28" viewBox="0 0 318.6 318.6">
                    <path fill="#E2761B" stroke="#E2761B" strokeMiterlimit="10" d="m274.1 35.5-99.5 73.9L193 65.8z"/>
                    <path fill="#E4761B" stroke="#E4761B" strokeMiterlimit="10" d="m44.4 35.5 98.7 74.6-17.5-44.3z"/>
                    <path fill="#E4761B" stroke="#E4761B" strokeMiterlimit="10" d="m238.3 206.8-28.5 42.2 56.8 15.6 16.3-56.5z"/>
                    <path fill="#E4761B" stroke="#E4761B" strokeMiterlimit="10" d="m35.5 208.1 16.2 56.5 56.8-15.6-28.5-42.2z"/>
                    <path fill="#E4761B" stroke="#E4761B" strokeMiterlimit="10" d="m87.9 146.4-16.7 25.2 59.8 2.6-2-43.2z"/>
                    <path fill="#E4761B" stroke="#E4761B" strokeMiterlimit="10" d="m230.7 146.4-41.5-15.5-1.6 43.3 59.8-2.6z"/>
                    <path fill="#D7C1B3" stroke="#D7C1B3" strokeMiterlimit="10" d="m87.9 249 35.8-17.4-31-23.7z"/>
                    <path fill="#D7C1B3" stroke="#D7C1B3" strokeMiterlimit="10" d="m194.9 231.6 35.8 17.4-4.8-41.1z"/>
                    <path fill="#233238" stroke="#233238" strokeMiterlimit="10" d="m123.7 231.6 34.6-17-29.3-12.8z"/>
                    <path fill="#233238" stroke="#233238" strokeMiterlimit="10" d="m160.3 214.6 34.6 17-5.3-29.8z"/>
                    <path fill="#CD6116" stroke="#CD6116" strokeMiterlimit="10" d="m123.7 231.6 5.3 38.6 30.3-8.8-35.6-29.8z"/>
                    <path fill="#CD6116" stroke="#CD6116" strokeMiterlimit="10" d="m159.3 261.4 30.3 8.8 5.3-38.6-35.6 29.8z"/>
                    <path fill="#E4751F" stroke="#E4751F" strokeMiterlimit="10" d="m194.9 231.6-35.6 29.8 30.3 8.8 5.3-38.6z"/>
                    <path fill="#E4751F" stroke="#E4751F" strokeMiterlimit="10" d="m123.7 231.6 5.3 38.6 30.3-8.8-35.6-29.8z"/>
                    <path fill="#F6851B" stroke="#F6851B" strokeMiterlimit="10" d="m159.3 124.6 15.3-38.8-30.6 0z"/>
                    <path fill="#C0AD9E" stroke="#C0AD9E" strokeMiterlimit="10" d="m159.3 124.6-28.3 49.6 56.6 0z"/>
                    <path fill="#161616" stroke="#161616" strokeMiterlimit="10" d="m159.3 201.8 28.3-27.6-56.6 0z"/>
                    <path fill="#763D16" stroke="#763D16" strokeMiterlimit="10" d="m131 174.2 28.3 27.6 28.3-27.6z"/>
                  </svg>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "0.9375rem" }}>MetaMask</div>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                      Desktop extension or Mobile QR
                    </div>
                  </div>
                </div>
                <span
                  style={{
                    fontSize: "0.6875rem",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--accent-brass)",
                    backgroundColor: "var(--accent-brass-dim)",
                    padding: "3px 8px",
                    borderRadius: 0,
                  }}
                >
                  MetaMask Connect
                </span>
              </button>

              {/* Injected Browser Wallet Option */}
              <button
                type="button"
                onClick={() => handleConnect("injected")}
                disabled={isPending}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "14px 16px",
                  backgroundColor: "var(--bg-base)",
                  border: "1px solid var(--border-hairline)",
                  borderRadius: 0,
                  color: "var(--text-primary)",
                  cursor: isPending ? "wait" : "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--accent-brass)";
                  e.currentTarget.style.backgroundColor = "var(--bg-surface)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--border-hairline)";
                  e.currentTarget.style.backgroundColor = "var(--bg-base)";
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-secondary)" }}>
                    <rect x="2" y="4" width="20" height="16" rx="2"/>
                    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
                  </svg>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "0.9375rem" }}>Browser Wallet</div>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                      Rabby, Coinbase, Brave, or Injected
                    </div>
                  </div>
                </div>
                <span
                  style={{
                    fontSize: "0.6875rem",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--text-secondary)",
                    backgroundColor: "var(--bg-elevated)",
                    padding: "3px 8px",
                    borderRadius: 0,
                  }}
                >
                  Injected
                </span>
              </button>
            </div>

            {/* Pending connection message */}
            {isPending && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "10px",
                  padding: "10px",
                  backgroundColor: "var(--accent-brass-dim)",
                  borderRadius: 0,
                  fontSize: "0.8125rem",
                  color: "var(--accent-brass)",
                }}
              >
                <span className="network-dot" style={{ backgroundColor: "var(--accent-brass)" }} />
                <span>
                  Connecting to {connectors.find((c) => c.id === pendingConnectorId)?.name || "wallet"}... Approve prompt in wallet.
                </span>
              </div>
            )}

            {/* Footer notice */}
            <div style={{ borderTop: "1px solid var(--border-hairline)", paddingTop: "14px" }}>
              <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textAlign: "center", lineHeight: 1.4 }}>
                Legacy is strictly non-custodial. Your private keys never leave your device.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ─── Account Details Modal ─── */}
      {isAccountOpen && address && (
        <div
          ref={accountDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="account-modal-title"
          className="modal-backdrop-animate"
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(16, 21, 26, 0.85)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "16px",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsAccountOpen(false);
          }}
        >
          <div
            className="panel-elevated modal-surface-animate"
            style={{
              width: "100%",
              maxWidth: "460px",
              padding: "28px",
              display: "flex",
              flexDirection: "column",
              gap: "20px",
            }}
          >
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <h2
                  id="account-modal-title"
                  className="font-display"
                  style={{ fontSize: "1.5rem", color: "var(--text-primary)" }}
                >
                  Connected Account
                </h2>
                <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginTop: "4px" }}>
                  Active wallet session
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsAccountOpen(false)}
                className="btn-secondary"
                style={{ padding: "4px 8px", fontSize: "0.8125rem" }}
                aria-label="Close dialog"
              >
                ✕
              </button>
            </div>

            {/* Address display card */}
            <div
              style={{
                backgroundColor: "var(--bg-base)",
                border: "1px solid var(--border-hairline)",
                borderRadius: 0,
                padding: "16px",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="label-overline">Wallet Address</span>
                <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                  {activeConnector?.name || "MetaMask"}
                </span>
              </div>
              <div
                className="font-data"
                style={{
                  fontSize: "0.875rem",
                  color: "var(--text-primary)",
                  wordBreak: "break-all",
                  lineHeight: 1.4,
                }}
              >
                {address}
              </div>

              {/* Actions row: Copy & Explorer */}
              <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="btn-secondary"
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "6px",
                    fontSize: "0.8125rem",
                    padding: "8px 12px",
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                  {copied ? "Copied!" : "Copy Address"}
                </button>

                <a
                  href={`https://sepolia.worldscan.org/address/${address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary"
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "6px",
                    fontSize: "0.8125rem",
                    padding: "8px 12px",
                    textDecoration: "none",
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                    <polyline points="15 3 21 3 21 9"/>
                    <line x1="10" y1="14" x2="21" y2="3"/>
                  </svg>
                  Worldscan
                </a>
              </div>
            </div>

            {/* Network card */}
            <div
              style={{
                backgroundColor: "var(--bg-base)",
                border: "1px solid var(--border-hairline)",
                borderRadius: 0,
                padding: "14px 16px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span
                  className="network-dot"
                  style={{
                    backgroundColor: chainId === worldChainSepolia.id ? "var(--status-green)" : "var(--status-red)",
                  }}
                />
                <div>
                  <div style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                    {chainId === worldChainSepolia.id ? "World Chain Sepolia" : "Unsupported Network"}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                    Chain ID: {chainId}
                  </div>
                </div>
              </div>

              {chainId !== worldChainSepolia.id && (
                <button
                  type="button"
                  onClick={() => switchChainAsync({ chainId: worldChainSepolia.id })}
                  disabled={isSwitching}
                  className="btn-brass"
                  style={{ fontSize: "0.75rem", padding: "6px 12px" }}
                >
                  {isSwitching ? "Switching..." : "Switch Network"}
                </button>
              )}
            </div>

            {/* Disconnect button */}
            <button
              type="button"
              onClick={handleDisconnect}
              className="btn-secondary"
              style={{
                width: "100%",
                padding: "10px",
                color: "var(--status-red)",
                borderColor: "rgba(193, 80, 63, 0.3)",
                fontSize: "0.875rem",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = "rgba(193, 80, 63, 0.1)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "transparent";
              }}
            >
              Disconnect Wallet
            </button>
          </div>
        </div>
      )}
    </WalletModalContext.Provider>
  );
}
