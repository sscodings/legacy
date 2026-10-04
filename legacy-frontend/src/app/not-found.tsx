import Link from "next/link";

export default function NotFound() {
  return (
    <div className="landing-canvas status-page">
      <div className="status-page-inner">
        <p className="status-page-code">[ 404 // PAGE NOT FOUND ]</p>
        <h1 className="section-title" style={{ fontSize: "clamp(2rem, 5vw, 3.25rem)", marginBottom: 12 }}>
          NOTHING HERE
        </h1>
        <p className="section-lead">
          This address doesn&apos;t match any page. Your vault and its funds are not affected.
        </p>
        <div className="status-page-actions">
          <Link href="/" className="btn-hero-action" style={{ marginTop: 0 }}>
            Back to home
          </Link>
          <Link href="/vault" className="btn-hero-action btn-hero-action--ghost" style={{ marginTop: 0 }}>
            Open dashboard
          </Link>
          <Link href="/lookup" className="btn-hero-action btn-hero-action--ghost" style={{ marginTop: 0 }}>
            Look up a vault
          </Link>
        </div>
      </div>
    </div>
  );
}
