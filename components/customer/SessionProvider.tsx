"use client";

// Phase 33.A — Client-side wrapper around NextAuth's <SessionProvider>.
// app/layout.tsx is a server component and can't render the NextAuth provider
// directly (it depends on React context). This thin client component bridges
// the gap.

import { SessionProvider } from "next-auth/react";

export default function NextAuthSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SessionProvider>{children}</SessionProvider>;
}
