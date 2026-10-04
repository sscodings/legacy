"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSignMessage } from "wagmi";
import {
  buildDeriveMessage,
  buildEnrollProofMessage,
  derivePrivateKey,
  derivePrivateKeyFromPrf,
  publicKeyFromPrivate,
  sha256Hex,
  unsealBytes,
  unsealMessage,
  type KeyScheme,
  type SealedBundle,
  type SealedVideoMeta,
} from "@/lib/inheritance/crypto";
import {
  createHeirPasskey,
  evaluateHeirPasskey,
  isPasskeyPrfAvailable,
  zeroBuffer,
} from "@/lib/inheritance/passkey";

interface SealedMessageHeirPanelProps {
  vaultAddress: `0x${string}`;
  heirAddress: `0x${string}`;
  isHeir: boolean;
}

interface HeirInheritanceState {
  enrolled: boolean;
  keyScheme?: KeyScheme | null;
  credentialId?: string | null;
  hasSealed: boolean;
  canReveal: boolean;
  sealedAt: number | null;
  bundle: SealedBundle | null;
  hasSealedVideo: boolean;
  sealedVideoAt: number | null;
  video: SealedVideoMeta | null;
  needsReseal?: boolean;
  needsResealVideo?: boolean;
}

export function SealedMessageHeirPanel({ vaultAddress, heirAddress, isHeir }: SealedMessageHeirPanelProps) {
  const { signMessageAsync } = useSignMessage();
  const [state, setState] = useState<HeirInheritanceState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prfAvailable, setPrfAvailable] = useState(false);

  const [videoBusy, setVideoBusy] = useState(false);
  const [videoStage, setVideoStage] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [revealedVideoUrl, setRevealedVideoUrl] = useState<string | null>(null);
  const revealedVideoUrlRef = useRef<string | null>(null);

  useEffect(() => {
    isPasskeyPrfAvailable().then(setPrfAvailable);
  }, []);

  // Revoke the object URL when it changes or the panel unmounts, so the
  // decrypted plaintext isn't kept around in memory longer than needed.
  useEffect(() => {
    revealedVideoUrlRef.current = revealedVideoUrl;
    return () => {
      if (revealedVideoUrlRef.current) URL.revokeObjectURL(revealedVideoUrlRef.current);
    };
  }, [revealedVideoUrl]);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/inheritance?vault=${vaultAddress}&heir=${heirAddress}`);
      const data = await res.json();
      if (res.ok) {
        setState({
          enrolled: Boolean(data.enrolled),
          keyScheme: data.keyScheme ?? null,
          credentialId: data.credentialId ?? null,
          hasSealed: Boolean(data.hasSealed),
          canReveal: Boolean(data.canReveal),
          sealedAt: data.sealedAt ?? null,
          bundle: data.bundle ?? null,
          hasSealedVideo: Boolean(data.hasSealedVideo),
          sealedVideoAt: data.sealedVideoAt ?? null,
          video: data.video ?? null,
          needsReseal: Boolean(data.needsReseal),
          needsResealVideo: Boolean(data.needsResealVideo),
        });
      }
    } catch {
      /* ignore — panel simply won't render actions */
    } finally {
      setIsLoading(false);
    }
  }, [vaultAddress, heirAddress]);

  useEffect(() => {
    if (isHeir) load();
  }, [isHeir, load]);

  const handleEnrollPasskey = async () => {
    try {
      setBusy(true);
      setError(null);

      // 1. WebAuthn PRF registration
      const { credentialId, prfOutput } = await createHeirPasskey(vaultAddress, heirAddress);

      // 2. Client-side key derivation
      const priv = derivePrivateKeyFromPrf(prfOutput, vaultAddress, heirAddress);
      const heirPublicKey = publicKeyFromPrivate(priv);

      // 3. Memory cleanup of raw key material
      zeroBuffer(prfOutput);
      zeroBuffer(priv);

      // 4. One-time wallet binding proof signature
      const issuedAt = Date.now();
      const message = buildEnrollProofMessage({
        vault: vaultAddress,
        heir: heirAddress,
        heirPublicKey,
        scheme: "passkey-prf",
        issuedAt,
      });
      const proofSignature = await signMessageAsync({ message });

      // 5. Publish public key (never secrets)
      const res = await fetch("/api/inheritance/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vaultAddress,
          heirAddress,
          keyScheme: "passkey-prf",
          heirPublicKey,
          credentialId,
          proofSignature,
          issuedAt,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Enrollment failed");
      await load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Passkey enrollment failed";
      setError(msg.includes("User rejected") ? "Signature request rejected." : msg);
    } finally {
      setBusy(false);
    }
  };

  const handleEnrollWallet = async () => {
    try {
      setBusy(true);
      setError(null);

      // 1. Client-side private key derivation (never sent to server)
      const deriveMessage = buildDeriveMessage(vaultAddress, heirAddress);
      const deriveSig = await signMessageAsync({ message: deriveMessage });
      const priv = derivePrivateKey(deriveSig);
      const heirPublicKey = publicKeyFromPrivate(priv);
      zeroBuffer(priv);

      // 2. Wallet binding proof signature (binding heirPublicKey to heir address)
      const issuedAt = Date.now();
      const proofMessage = buildEnrollProofMessage({
        vault: vaultAddress,
        heir: heirAddress,
        heirPublicKey,
        scheme: "wallet-signature",
        issuedAt,
      });
      const proofSignature = await signMessageAsync({ message: proofMessage });

      // 3. Publish public key (never secrets or deriveSig)
      const res = await fetch("/api/inheritance/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vaultAddress,
          heirAddress,
          keyScheme: "wallet-signature",
          heirPublicKey,
          proofSignature,
          issuedAt,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Enrollment failed");
      await load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Wallet key enrollment failed";
      setError(msg.includes("User rejected") ? "Signature request rejected." : msg);
    } finally {
      setBusy(false);
    }
  };

  const handleUnseal = async () => {
    if (!state?.bundle) return;
    try {
      setBusy(true);
      setError(null);

      let priv: Uint8Array;
      if (state.keyScheme === "passkey-prf") {
        // Biometric / TouchID prompt only — no wallet signature needed!
        const prfOutput = await evaluateHeirPasskey(
          vaultAddress,
          heirAddress,
          state.credentialId || undefined
        );
        priv = derivePrivateKeyFromPrf(prfOutput, vaultAddress, heirAddress);
        zeroBuffer(prfOutput);
      } else {
        const message = buildDeriveMessage(vaultAddress, heirAddress);
        const signature = await signMessageAsync({ message });
        priv = derivePrivateKey(signature);
      }

      const plaintext = unsealMessage(state.bundle, priv);
      zeroBuffer(priv);
      setRevealed(plaintext);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to unseal";
      setError(
        msg.includes("User rejected")
          ? "Verification was rejected."
          : "Could not decrypt. Ensure you're using the registered passkey or wallet."
      );
    } finally {
      setBusy(false);
    }
  };

  const handleUnsealVideo = async () => {
    if (!state?.video) return;
    try {
      setVideoBusy(true);
      setVideoError(null);

      setVideoStage("Fetching encrypted video…");
      const res = await fetch(state.video.blobUrl);
      if (!res.ok) throw new Error("Failed to download the sealed video.");
      const ciphertext = new Uint8Array(await res.arrayBuffer());

      // Defense in depth: confirms the fetched bytes match what the owner
      // actually signed off on, independent of the decryption step below.
      const actualHash = sha256Hex(ciphertext);
      if (actualHash !== state.video.ciphertextHash) {
        throw new Error("Video integrity check failed — the downloaded file doesn't match what was sealed.");
      }

      setVideoStage("Authorizing & decrypting…");
      let priv: Uint8Array;
      if (state.keyScheme === "passkey-prf") {
        const prfOutput = await evaluateHeirPasskey(
          vaultAddress,
          heirAddress,
          state.credentialId || undefined
        );
        priv = derivePrivateKeyFromPrf(prfOutput, vaultAddress, heirAddress);
        zeroBuffer(prfOutput);
      } else {
        const message = buildDeriveMessage(vaultAddress, heirAddress);
        const signature = await signMessageAsync({ message });
        priv = derivePrivateKey(signature);
      }

      const plaintext = unsealBytes(state.video.ephPub, state.video.nonce, ciphertext, priv);
      zeroBuffer(priv);

      const blob = new Blob([new Uint8Array(plaintext)], { type: state.video.mimeType });
      setRevealedVideoUrl(URL.createObjectURL(blob));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to unseal video";
      setVideoError(
        msg.includes("User rejected")
          ? "Verification rejected."
          : msg.includes("integrity check")
          ? msg
          : "Could not decrypt. Ensure you're using the registered passkey or wallet."
      );
    } finally {
      setVideoBusy(false);
      setVideoStage(null);
    }
  };

  if (!isHeir) return null;

  return (
    <section className="console-card">
      <div className="console-tabpanel panel-stack">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <h3 className="panel-title" style={{ fontSize: "1.0625rem", margin: 0 }}>
            Sealed message
          </h3>
          {state?.enrolled && (
            <span className="state-pill" style={{ fontSize: "0.75rem" }}>
              {state.keyScheme === "passkey-prf" ? "🔐 Passkey (Biometric)" : "🔑 Wallet signature"}
            </span>
          )}
        </div>

        {isLoading || !state ? (
          <div className="skeleton-shimmer" style={{ width: "100%", height: 60, borderRadius: 0 }} />
        ) : !state.enrolled ? (
          <>
            <p className="panel-lead">
              Set up your key so only you can read a message or video the owner leaves you.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {prfAvailable && (
                <button
                  type="button"
                  onClick={handleEnrollPasskey}
                  disabled={busy}
                  className="flow-btn"
                >
                  {busy ? "Setting up passkey…" : "Set up with Passkey (Touch ID / Face ID)"}
                </button>
              )}
              <button
                type="button"
                onClick={handleEnrollWallet}
                disabled={busy}
                className={prfAvailable ? "flow-btn flow-btn--ghost" : "flow-btn"}
              >
                {busy ? "Waiting for signature…" : prfAvailable ? "Use wallet signature instead" : "Set up with wallet key"}
              </button>
            </div>
          </>
        ) : (
          <>
            {state.keyScheme !== "passkey-prf" && prfAvailable && (
              <div className="panel-note" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <strong>Biometric passkeys supported.</strong> Upgrade to unseal messages with Touch ID / Face ID without wallet signatures.
                </div>
                <button
                  type="button"
                  onClick={handleEnrollPasskey}
                  disabled={busy}
                  className="flow-btn flow-btn--ghost"
                  style={{ padding: "4px 12px", fontSize: "0.75rem" }}
                >
                  {busy ? "Upgrading…" : "Upgrade to Passkey"}
                </button>
              </div>
            )}

            {(state.needsReseal || state.needsResealVideo) && (
              <div className="panel-note panel-note--error">
                <strong>Key updated:</strong> You recently rotated or upgraded your decryption key. The vault owner needs to reseal their message with your new key before you can open it.
              </div>
            )}

            {!state.hasSealed && !state.hasSealedVideo ? (
              <p className="panel-lead">Nothing yet. It&apos;ll appear here once the owner seals a message or video.</p>
            ) : !state.canReveal ? (
              <div className="panel-note">
                <strong>
                  A sealed {state.hasSealed && state.hasSealedVideo ? "message and video are" : state.hasSealedVideo ? "video is" : "message is"} waiting.
                </strong>{" "}
                It unlocks once claims open.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                {state.hasSealed && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {revealed !== null ? (
                      <>
                        <span className="state-pill">
                          <span className="network-dot" style={{ backgroundColor: "var(--status-green)" }} />
                          Decrypted · visible only in your browser
                        </span>
                        <pre
                          className="panel-summary font-data"
                          style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                        >
                          {revealed}
                        </pre>
                        <button
                          type="button"
                          onClick={() => setRevealed(null)}
                          className="flow-btn flow-btn--ghost"
                          style={{ alignSelf: "flex-start" }}
                        >
                          Hide
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="panel-note panel-note--success">
                          <strong>A sealed message is ready.</strong>{" "}
                          {state.keyScheme === "passkey-prf"
                            ? "Use Touch ID / Face ID to decrypt it in your browser."
                            : "Sign with your wallet to decrypt it in your browser."}
                        </div>
                        <button
                          type="button"
                          onClick={handleUnseal}
                          disabled={busy || state.needsReseal}
                          className="flow-btn"
                          style={{ alignSelf: "flex-start" }}
                        >
                          {busy
                            ? "Decrypting…"
                            : state.keyScheme === "passkey-prf"
                            ? "Unseal with Passkey"
                            : "Unseal message"}
                        </button>
                      </>
                    )}
                  </div>
                )}

                {state.hasSealedVideo && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      borderTop: state.hasSealed ? "1px solid var(--border-hairline)" : undefined,
                      paddingTop: state.hasSealed ? 16 : 0,
                    }}
                  >
                    {revealedVideoUrl ? (
                      <>
                        <span className="state-pill">
                          <span className="network-dot" style={{ backgroundColor: "var(--status-green)" }} />
                          Decrypted · visible only in your browser
                        </span>
                        <video controls src={revealedVideoUrl} style={{ width: "100%", maxHeight: 420, borderRadius: 0, background: "#000000" }} />
                        <button
                          type="button"
                          onClick={() => setRevealedVideoUrl(null)}
                          className="flow-btn flow-btn--ghost"
                          style={{ alignSelf: "flex-start" }}
                        >
                          Hide
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="panel-note panel-note--success">
                          <strong>A sealed video is ready.</strong>{" "}
                          {state.keyScheme === "passkey-prf"
                            ? "Use Touch ID / Face ID to decrypt it in your browser."
                            : "Sign with your wallet to decrypt it in your browser."}
                        </div>
                        {videoStage && <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>{videoStage}</span>}
                        <button
                          type="button"
                          onClick={handleUnsealVideo}
                          disabled={videoBusy || state.needsResealVideo}
                          className="flow-btn"
                          style={{ alignSelf: "flex-start" }}
                        >
                          {videoBusy
                            ? "Decrypting…"
                            : state.keyScheme === "passkey-prf"
                            ? "Unseal video with Passkey"
                            : "Unseal video"}
                        </button>
                        {videoError && <div className="panel-note panel-note--error">{videoError}</div>}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {error && <div className="panel-note panel-note--error">{error}</div>}
      </div>
    </section>
  );
}
