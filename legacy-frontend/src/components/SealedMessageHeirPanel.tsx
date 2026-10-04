"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSignMessage } from "wagmi";
import {
  buildDeriveMessage,
  derivePrivateKey,
  sha256Hex,
  unsealBytes,
  unsealMessage,
  type SealedBundle,
  type SealedVideoMeta,
} from "@/lib/inheritance/crypto";

interface SealedMessageHeirPanelProps {
  vaultAddress: `0x${string}`;
  heirAddress: `0x${string}`;
  isHeir: boolean;
}

interface HeirInheritanceState {
  enrolled: boolean;
  hasSealed: boolean;
  canReveal: boolean;
  sealedAt: number | null;
  bundle: SealedBundle | null;
  hasSealedVideo: boolean;
  sealedVideoAt: number | null;
  video: SealedVideoMeta | null;
}

export function SealedMessageHeirPanel({ vaultAddress, heirAddress, isHeir }: SealedMessageHeirPanelProps) {
  const { signMessageAsync } = useSignMessage();
  const [state, setState] = useState<HeirInheritanceState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [videoBusy, setVideoBusy] = useState(false);
  const [videoStage, setVideoStage] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [revealedVideoUrl, setRevealedVideoUrl] = useState<string | null>(null);
  const revealedVideoUrlRef = useRef<string | null>(null);

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
          hasSealed: Boolean(data.hasSealed),
          canReveal: Boolean(data.canReveal),
          sealedAt: data.sealedAt ?? null,
          bundle: data.bundle ?? null,
          hasSealedVideo: Boolean(data.hasSealedVideo),
          sealedVideoAt: data.sealedVideoAt ?? null,
          video: data.video ?? null,
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

  const handleEnroll = async () => {
    try {
      setBusy(true);
      setError(null);
      const message = buildDeriveMessage(vaultAddress, heirAddress);
      const signature = await signMessageAsync({ message });
      const res = await fetch("/api/inheritance/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vaultAddress, heirAddress, signature }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Enrollment failed");
      await load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Enrollment failed";
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
      const message = buildDeriveMessage(vaultAddress, heirAddress);
      const signature = await signMessageAsync({ message });
      const priv = derivePrivateKey(signature);
      const plaintext = unsealMessage(state.bundle, priv);
      setRevealed(plaintext);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to unseal";
      // A wrong signature (non-deterministic wallet) yields an auth failure on decrypt.
      setError(
        msg.includes("User rejected")
          ? "Signature request rejected."
          : "Could not decrypt. Ensure you're using the same wallet that enrolled this key."
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

      setVideoStage("Deriving key & decrypting…");
      const message = buildDeriveMessage(vaultAddress, heirAddress);
      const signature = await signMessageAsync({ message });
      const priv = derivePrivateKey(signature);
      const plaintext = unsealBytes(state.video.ephPub, state.video.nonce, ciphertext, priv);

      const blob = new Blob([new Uint8Array(plaintext)], { type: state.video.mimeType });
      setRevealedVideoUrl(URL.createObjectURL(blob));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to unseal video";
      setVideoError(
        msg.includes("User rejected")
          ? "Signature request rejected."
          : msg.includes("integrity check")
          ? msg
          : "Could not decrypt. Ensure you're using the same wallet that enrolled this key."
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
        <h3 className="panel-title" style={{ fontSize: "1.0625rem" }}>
          Sealed message
        </h3>

{isLoading || !state ? (
          <div className="skeleton-shimmer" style={{ width: "100%", height: 60, borderRadius: 0 }} />
        ) : !state.enrolled ? (
          <>
            <p className="panel-lead">
              Set up your key (free, one signature) so only you can read a message or video the owner leaves you.
            </p>
            <button type="button" onClick={handleEnroll} disabled={busy} className="flow-btn" style={{ alignSelf: "flex-start" }}>
              {busy ? "Waiting for signature…" : "Set up your key"}
            </button>
          </>
        ) : !state.hasSealed && !state.hasSealedVideo ? (
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
                      <strong>A sealed message is ready.</strong> Sign to decrypt it in your browser.
                    </div>
                    <button type="button" onClick={handleUnseal} disabled={busy} className="flow-btn" style={{ alignSelf: "flex-start" }}>
                      {busy ? "Decrypting…" : "Unseal message"}
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
                      <strong>A sealed video is ready.</strong> Sign to decrypt it in your browser.
                    </div>
                    {videoStage && <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>{videoStage}</span>}
                    <button
                      type="button"
                      onClick={handleUnsealVideo}
                      disabled={videoBusy}
                      className="flow-btn"
                      style={{ alignSelf: "flex-start" }}
                    >
                      {videoBusy ? "Decrypting…" : "Unseal video"}
                    </button>
                    {videoError && <div className="panel-note panel-note--error">{videoError}</div>}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {error && <div className="panel-note panel-note--error">{error}</div>}
      </div>
    </section>
  );
}
