"use client";

import { signOut, useSession } from "next-auth/react";
import { useState } from "react";

/**
 * Sign-out control for the launcher screen.
 *
 * Pinned top-right (absolute) so it doesn't shift the centered hero. Renders
 * only after the session is confirmed client-side — keeps server-rendered HTML
 * static while still showing the user's identity inline (small label + email
 * tooltip + sign-out action).
 *
 * Visual: ghost button — transparent until hover, then brass border + char
 * text, matching the Watchfire register used on every other page. Avoids
 * competing with the centered "Welcome back" hero.
 */
export default function LauncherSignOut() {
  const { data: session, status } = useSession();
  const [submitting, setSubmitting] = useState(false);

  if (status !== "authenticated") return null;

  const userEmail = session?.user?.email ?? "";
  const userName = (session?.user?.name ?? "").trim();
  const initial = (userName || userEmail || "?").charAt(0).toUpperCase();

  async function handleSignOut() {
    setSubmitting(true);
    // callbackUrl drops the user on the sign-in page after token revocation.
    // NextAuth handles the redirect; we never reach the line after this.
    await signOut({ callbackUrl: "/auth/signin" });
  }

  return (
    <div
      style={{
        position: "absolute",
        top: 24,
        right: 24,
        zIndex: 5,
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontFamily: "-apple-system, Inter, system-ui, sans-serif",
        fontSize: 13,
      }}
    >
      {/* Avatar pill — initial + email on hover via title attr */}
      <div
        title={userEmail}
        aria-label={`Signed in as ${userEmail}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 10px 4px 4px",
          borderRadius: 999,
          background: "rgba(43, 31, 20, 0.04)",
          border: "1px solid rgba(43, 31, 20, 0.10)",
          color: "var(--zoca-text)",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            borderRadius: 999,
            background: "linear-gradient(135deg, #D9A441 0%, #C8431D 100%)",
            color: "#F0E4CC",
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontWeight: 600,
            fontSize: 13,
          }}
          aria-hidden
        >
          {initial}
        </span>
        <span style={{ color: "var(--zoca-text-2)", fontSize: 12 }}>
          {userName || userEmail.split("@")[0]}
        </span>
      </div>

      <button
        onClick={handleSignOut}
        disabled={submitting}
        style={{
          padding: "6px 14px",
          background: "transparent",
          border: "1px solid rgba(43, 31, 20, 0.20)",
          borderRadius: 8,
          color: "var(--zoca-text)",
          fontSize: 13,
          fontWeight: 500,
          cursor: submitting ? "wait" : "pointer",
          opacity: submitting ? 0.6 : 1,
          transition: "border-color 0.15s ease, background 0.15s ease",
        }}
        onMouseEnter={(e) => {
          if (submitting) return;
          (e.target as HTMLButtonElement).style.borderColor = "#C8431D";
          (e.target as HTMLButtonElement).style.background = "rgba(200, 67, 29, 0.06)";
        }}
        onMouseLeave={(e) => {
          (e.target as HTMLButtonElement).style.borderColor = "rgba(43, 31, 20, 0.20)";
          (e.target as HTMLButtonElement).style.background = "transparent";
        }}
      >
        {submitting ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
