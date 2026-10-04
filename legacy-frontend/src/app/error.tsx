"use client";

import Link from "next/link";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="landing-canvas status-page" role="alert">
      <div className="status-page-inner">
        <p className="status-page-code">[ ERROR // PAGE FAILED TO LOAD ]</p>
        <h1 className="section-title" style={{ fontSize: "clamp(2rem, 5vw, 3.25rem)", marginBottom: 12 }}>
          THIS PAGE HIT A PROBLEM
        </h1>
        <p className="section-lead">
          Nothing was sent on-chain. Try again, and if it keeps happening, reload the page or reconnect your wallet.
        </p>
        {error.digest && (
          <p className="font-data" style={{ marginTop: 12, fontSize: "0.75rem", color: "var(--text-secondary)" }}>
            Reference: {error.digest}
          </p>
        )}
        <div className="status-page-actions">
          <button type="button" onClick={reset} className="btn-hero-action" style={{ marginTop: 0 }}>
            Try again
          </button>
          <Link href="/" className="btn-hero-action btn-hero-action--ghost" style={{ marginTop: 0 }}>
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
