import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { mursGothic } from "@/lib/fonts";

export const metadata: Metadata = {
  title: "LEGACY · Autonomous Succession Protocol",
  description:
    "Self-sovereign digital inheritance and dead man's switch on World Chain, cryptographically guarded by World ID Proof of Personhood.",
  openGraph: {
    title: "LEGACY · Autonomous Succession Protocol",
    description: "Self-sovereign digital inheritance and dead man's switch on World Chain.",
    type: "website",
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon.ico" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={mursGothic.variable}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.ClientAnalytics = window.ClientAnalytics || { init: function(){}, identify: function(){}, optOut: function(){}, PlatformName: { web: "web" }, automatedEvents: {}, automatedMappingConfig: {} };`,
          }}
        />
      </head>


      <body>
        <Providers>
          <div className="app-layout">
            <a href="#main-content" className="skip-link">
              Skip to content
            </a>
            <Header />
            <main id="main-content" tabIndex={-1} style={{ flex: 1, outline: "none" }}>
              {children}
            </main>
            <Footer />
          </div>
        </Providers>
      </body>
    </html>
  );
}

