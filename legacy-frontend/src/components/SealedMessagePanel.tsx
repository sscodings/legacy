"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSignMessage } from "wagmi";
import { upload } from "@vercel/blob/client";
import {
  buildSealMessage,
  buildSealVideoMessage,
  digestBundle,
  digestVideoMeta,
  sealBytes,
  sealMessage,
  sha256Hex,
} from "@/lib/inheritance/crypto";

interface SealedMessagePanelProps {
  vaultAddress: `0x${string}`;
  ownerAddress: `0x${string}`;
  heirs: readonly `0x${string}`[];
  /** Lowercased heir address → display name. */
  heirNames?: Record<string, string>;
  onGoToHeirs?: () => void;
}

/** Ciphertext is ~plaintext size + a small AEAD tag; keep well under the 200MB server-side cap. */
const MAX_VIDEO_BYTES = 190 * 1024 * 1024;

interface InheritanceState {
  enrolled: boolean;
  heirPublicKey: string | null;
  hasSealed: boolean;
  sealedAt: number | null;
  hasSealedVideo: boolean;
  sealedVideoAt: number | null;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function SealedMessagePanel({ vaultAddress, ownerAddress, heirs, heirNames = {}, onGoToHeirs }: SealedMessagePanelProps) {
  const nameOf = (h: string) => heirNames[h.toLowerCase()] ?? short(h);
  const [linkCopied, setLinkCopied] = useState(false);
  const copyPortalLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/claim?v=${vaultAddress}`);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };
  const { signMessageAsync } = useSignMessage();
  const [selectedHeir, setSelectedHeir] = useState<`0x${string}` | null>(heirs[0] ?? null);
  const [state, setState] = useState<InheritanceState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [text, setText] = useState("");
  const [isSealing, setIsSealing] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; isError: boolean } | null>(null);

  useEffect(() => {
    if (!selectedHeir && heirs.length > 0) setSelectedHeir(heirs[0]);
  }, [heirs, selectedHeir]);

  const loadState = useCallback(async (heir: `0x${string}`) => {
    setIsLoading(true);
    setState(null);
    try {
      const res = await fetch(`/api/inheritance?vault=${vaultAddress}&heir=${heir}`);
      const data = await res.json();
      if (res.ok) {
        setState({
          enrolled: Boolean(data.enrolled),
          heirPublicKey: data.heirPublicKey ?? null,
          hasSealed: Boolean(data.hasSealed),
          sealedAt: data.sealedAt ?? null,
          hasSealedVideo: Boolean(data.hasSealedVideo),
          sealedVideoAt: data.sealedVideoAt ?? null,
        });
      } else {
        setState({
          enrolled: false,
          heirPublicKey: null,
          hasSealed: false,
          sealedAt: null,
          hasSealedVideo: false,
          sealedVideoAt: null,
        });
      }
    } catch {
      setState({
        enrolled: false,
        heirPublicKey: null,
        hasSealed: false,
        sealedAt: null,
        hasSealedVideo: false,
        sealedVideoAt: null,
      });
    } finally {
      setIsLoading(false);
    }
  }, [vaultAddress]);

  useEffect(() => {
    if (selectedHeir) loadState(selectedHeir);
  }, [selectedHeir, loadState]);

  const handleSeal = async () => {
    if (!selectedHeir || !state?.heirPublicKey || !signMessageAsync) return;
    if (text.trim().length === 0) {
      setFeedback({ text: "Write a message first.", isError: true });
      return;
    }
    try {
      setIsSealing(true);
      setFeedback(null);

      const bundle = sealMessage(text, state.heirPublicKey);
      const digest = digestBundle(bundle);
      const message = buildSealMessage(vaultAddress, selectedHeir, digest);
      const signature = await signMessageAsync({ message });

      const res = await fetch("/api/inheritance/seal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vaultAddress,
          heirAddress: selectedHeir,
          ownerAddress,
          bundle,
          signature,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to seal message");

      setFeedback({ text: `Sealed. Only ${nameOf(selectedHeir)} can open it, once the vault passes to them.`, isError: false });
      setText("");
      loadState(selectedHeir);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to seal message";
      setFeedback({ text: msg.includes("User rejected") ? "You declined the signature in your wallet." : msg, isError: true });
    } finally {
      setIsSealing(false);
    }
  };

  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [isSealingVideo, setIsSealingVideo] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [videoStage, setVideoStage] = useState<string | null>(null);

  const handleSelectVideoFile = (file: File | null) => {
    setFeedback(null);
    if (file && file.size > MAX_VIDEO_BYTES) {
      setFeedback({
        text: `That video is ${(file.size / (1024 * 1024)).toFixed(0)}MB — the limit is ${(MAX_VIDEO_BYTES / (1024 * 1024)).toFixed(0)}MB.`,
        isError: true,
      });
      setVideoFile(null);
      if (videoInputRef.current) videoInputRef.current.value = "";
      return;
    }
    setVideoFile(file);
  };

  const handleSealVideo = async () => {
    if (!selectedHeir || !state?.heirPublicKey || !signMessageAsync) return;
    if (!videoFile) {
      setFeedback({ text: "Choose a video first.", isError: true });
      return;
    }
    try {
      setIsSealingVideo(true);
      setFeedback(null);
      setUploadPct(0);

      setVideoStage("Encrypting in your browser…");
      const plaintext = new Uint8Array(await videoFile.arrayBuffer());
      const { ephPub, nonce, ciphertext } = sealBytes(plaintext, state.heirPublicKey);
      const ciphertextHash = sha256Hex(ciphertext);

      setVideoStage("Uploading encrypted video…");
      const blob = await upload(
        `sealed-videos/${vaultAddress.toLowerCase()}/${selectedHeir.toLowerCase()}-${Date.now()}.enc`,
        new Blob([new Uint8Array(ciphertext)]),
        {
          access: "public",
          contentType: "application/octet-stream",
          handleUploadUrl: "/api/inheritance/video-upload",
          clientPayload: JSON.stringify({ vaultAddress, heirAddress: selectedHeir, ownerAddress }),
          onUploadProgress: ({ percentage }) => setUploadPct(percentage),
        }
      );

      setVideoStage("Signing…");
      const video = {
        ephPub,
        nonce,
        blobUrl: blob.url,
        ciphertextHash,
        mimeType: videoFile.type || "video/mp4",
        size: plaintext.byteLength,
      };
      const digest = digestVideoMeta(video);
      const message = buildSealVideoMessage(vaultAddress, selectedHeir, digest);
      const signature = await signMessageAsync({ message });

      setVideoStage("Saving…");
      const res = await fetch("/api/inheritance/seal-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vaultAddress, heirAddress: selectedHeir, ownerAddress, video, signature }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to seal video");

      setFeedback({ text: `Video sealed. Only ${nameOf(selectedHeir)} can open it, once the vault passes to them.`, isError: false });
      setVideoFile(null);
      if (videoInputRef.current) videoInputRef.current.value = "";
      loadState(selectedHeir);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to seal video";
      setFeedback({ text: msg.includes("User rejected") ? "You declined the signature in your wallet." : msg, isError: true });
    } finally {
      setIsSealingVideo(false);
      setVideoStage(null);
    }
  };

  return (
    <div className="panel-stack">
      <div className="panel-head">
        <div>
          <h3 className="panel-title">Sealed message</h3>
          <p className="panel-lead">
            Leave a private note or video for one heir. Only they can open it, and only after the vault passes to them.
          </p>
        </div>
      </div>

      {heirs.length === 0 ? (
        <div className="panel-empty">
          <span>Add an heir first. Each message is sealed to one person.</span>
          {onGoToHeirs && (
            <button type="button" className="flow-btn flow-btn--ghost" onClick={onGoToHeirs}>
              Go to heirs
            </button>
          )}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>To</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }} role="group" aria-label="Choose heir">
              {heirs.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="chip"
                  aria-pressed={h.toLowerCase() === selectedHeir?.toLowerCase()}
                  onClick={() => {
                    setFeedback(null);
                    setSelectedHeir(h);
                  }}
                  title={h}
                >
                  {nameOf(h)}
                </button>
              ))}
            </div>
          </div>

          {isLoading || !state ? (
            <div className="skeleton-shimmer" style={{ width: "100%", height: 140, borderRadius: 0 }} />
          ) : !state.enrolled ? (
            <div className="console-alert console-alert--warning">
              <div className="console-alert-body">
                <strong>{nameOf(selectedHeir!)} needs to set up their key first</strong>
                <p>Ask them to open the heir portal and sign in once. You can write to them right after.</p>
              </div>
              <button type="button" className="flow-btn flow-btn--ghost" onClick={copyPortalLink}>
                {linkCopied ? "Link copied" : "Copy portal link"}
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={`Write something only ${nameOf(selectedHeir!)} will read…`}
                rows={6}
                className="flow-input"
                aria-label="Message"
                style={{ resize: "vertical", lineHeight: 1.6 }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
                  {state.hasSealed && state.sealedAt
                    ? `Saving replaces the message you sealed on ${new Date(state.sealedAt).toLocaleDateString()}.`
                    : "You won't be able to read it again after sealing."}
                </span>
                <button type="button" onClick={handleSeal} disabled={isSealing || text.trim().length === 0} className="flow-btn">
                  {isSealing ? "Sealing…" : state.hasSealed ? "Replace message" : "Seal message"}
                </button>
              </div>

              <div style={{ borderTop: "1px solid var(--border-hairline)", paddingTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                <span style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
                  Or leave a video{state.hasSealedVideo && state.sealedVideoAt ? ` — replacing the one sealed on ${new Date(state.sealedVideoAt).toLocaleDateString()}` : ""}
                </span>

                <input
                  ref={videoInputRef}
                  type="file"
                  accept="video/*"
                  aria-label="Video message"
                  disabled={isSealingVideo}
                  onChange={(e) => handleSelectVideoFile(e.target.files?.[0] ?? null)}
                  style={{ display: "none" }}
                />

                {!videoFile ? (
                  <button
                    type="button"
                    onClick={() => videoInputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      handleSelectVideoFile(e.dataTransfer.files?.[0] ?? null);
                    }}
                    disabled={isSealingVideo}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 8,
                      padding: "28px 20px",
                      borderRadius: 0,
                      border: "1px dashed rgba(255, 255, 255, 0.18)",
                      background: "rgba(255, 255, 255, 0.02)",
                      color: "var(--text-secondary)",
                      cursor: isSealingVideo ? "not-allowed" : "pointer",
                      transition: "border-color 150ms ease, background-color 150ms ease",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.35)";
                      e.currentTarget.style.background = "rgba(255, 255, 255, 0.04)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.18)";
                      e.currentTarget.style.background = "rgba(255, 255, 255, 0.02)";
                    }}
                  >
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="2" y="5" width="14" height="14" rx="2" />
                      <path d="M16 10l6-3v10l-6-3" />
                    </svg>
                    <span style={{ fontSize: "0.875rem", color: "#ffffff" }}>Choose a video, or drag one here</span>
                    <span style={{ fontSize: "0.75rem" }}>
                      Up to {(MAX_VIDEO_BYTES / (1024 * 1024)).toFixed(0)}MB
                    </span>
                  </button>
                ) : (
                  <div className="setting-row" style={{ borderRadius: 0, border: "1px solid rgba(255, 255, 255, 0.08)" }}>
                    <div className="setting-label" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--text-secondary)", flexShrink: 0 }}>
                        <rect x="2" y="5" width="14" height="14" rx="2" />
                        <path d="M16 10l6-3v10l-6-3" />
                      </svg>
                      <div style={{ minWidth: 0 }}>
                        <strong style={{ overflowWrap: "anywhere" }}>{videoFile.name}</strong>
                        <span>{(videoFile.size / (1024 * 1024)).toFixed(1)}MB</span>
                      </div>
                    </div>
                    {!isSealingVideo && (
                      <button
                        type="button"
                        onClick={() => {
                          setVideoFile(null);
                          if (videoInputRef.current) videoInputRef.current.value = "";
                        }}
                        className="flow-btn flow-btn--ghost"
                        style={{ padding: "6px 14px", fontSize: "0.8125rem" }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                )}

                {isSealingVideo && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                      {videoStage}{uploadPct > 0 && uploadPct < 100 ? ` — ${uploadPct.toFixed(0)}%` : ""}
                    </span>
                    <div style={{ height: 6, borderRadius: 999, background: "rgba(255, 255, 255, 0.08)", overflow: "hidden" }}>
                      <div
                        style={{
                          width: `${Math.max(uploadPct, videoStage ? 4 : 0)}%`,
                          height: "100%",
                          borderRadius: 999,
                          backgroundColor: "#ffffff",
                          transition: "width 0.2s ease",
                        }}
                      />
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleSealVideo}
                  disabled={isSealingVideo || !videoFile}
                  className="flow-btn flow-btn--ghost"
                  style={{ alignSelf: "flex-start" }}
                >
                  {isSealingVideo ? "Sealing video…" : state.hasSealedVideo ? "Replace video" : "Seal video"}
                </button>
              </div>
            </div>
          )}

          {feedback && (
            <div className={`panel-note ${feedback.isError ? "panel-note--error" : "panel-note--success"}`}>{feedback.text}</div>
          )}
        </>
      )}
    </div>
  );
}
