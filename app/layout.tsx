import type { Metadata } from "next";
import SessionProvider from "@/components/SessionProvider";
import FaviconFlicker from "@/components/FaviconFlicker";
import CommandPaletteProvider from "@/components/CommandPaletteProvider";
import KeyboardShortcuts from "@/components/KeyboardShortcuts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Beacon — Zoca",
  description:
    "Beacon — the gateway to Zoca's internal agents. Customer Beacon, Performance Beacon, Escalation Beacon, Post-Payment Reviews.",
  manifest: "/manifest.json",
  themeColor: "#F0E4CC",
  openGraph: {
    title: "Beacon — A signal worth following.",
    description: "Gateway to Zoca's internal agents.",
    images: ["/og-card.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Beacon — A signal worth following.",
    description: "Gateway to Zoca's internal agents.",
    images: ["/og-card.png"],
  },
  // Phase E-7 polish — restored v1 Beacon flame favicons. The static SVGs
  // give Firefox + Safari SMIL-driven flicker; the FaviconFlicker client
  // component below drives Chrome (which ignores SMIL on favicons) by
  // swapping data-URL frames every ~140ms.
  icons: {
    icon: [
      { url: "/favicon-16.svg",  sizes: "16x16",   type: "image/svg+xml" },
      { url: "/favicon-32.svg",  sizes: "32x32",   type: "image/svg+xml" },
      { url: "/favicon-48.svg",  sizes: "48x48",   type: "image/svg+xml" },
      { url: "/favicon-192.svg", sizes: "192x192", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <FaviconFlicker />
        <SessionProvider>
          {children}
          {/* Phase E-9 — Cmd+K cross-agent command palette + global
              keyboard shortcuts (?, g-prefix nav). Both mounted inside
              SessionProvider so any future shortcut that calls the
              activity logger has session context. */}
          <CommandPaletteProvider />
          <KeyboardShortcuts />
        </SessionProvider>
      </body>
    </html>
  );
}
