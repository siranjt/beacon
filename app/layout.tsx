import type { Metadata } from "next";
import SessionProvider from "@/components/SessionProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Beacon — Zoca",
  description:
    "Beacon — the gateway to Zoca's internal agents. Customer Beacon, Performance Beacon, Escalation Beacon, Post-Payment Reviews.",
  themeColor: "#F0E4CC",
  openGraph: {
    title: "Beacon — A signal worth following.",
    description: "Gateway to Zoca's internal agents.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
