"use client";

import { signIn } from "next-auth/react";
import BeaconAmbient from "@/components/BeaconAmbient";

/**
 * Beacon sign-in screen — the "front door."
 *
 * Visually identical to Customer Beacon's sign-in. After successful sign-in,
 * NextAuth redirects to `/` (the launcher).
 */
export default function SignInPage() {
  return (
    <main style={{ position: "relative", minHeight: "100vh", background: "var(--zoca-bg)" }}>
      <BeaconAmbient />

      <div
        style={{
          position: "relative",
          zIndex: 2,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          padding: "1.5rem",
        }}
      >
        {/* Spacer to push the card below the BEACON ambient lockup */}
        <div style={{ height: "55vh" }} />

        <div
          className="beacon-card"
          style={{
            maxWidth: 380,
            width: "100%",
            background: "rgba(248, 239, 215, 0.85)",
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
          }}
        >
          <h2
            style={{
              margin: 0,
              fontFamily: 'Georgia, "Times New Roman", serif',
              fontSize: 22,
              fontWeight: 600,
              color: "var(--zoca-text)",
              textAlign: "center",
            }}
          >
            Follow the signal
          </h2>
          <p
            style={{
              margin: "0.25rem 0 1rem",
              fontFamily: "-apple-system, Inter, system-ui, sans-serif",
              fontSize: 11,
              color: "var(--zoca-text-2)",
              textAlign: "center",
            }}
          >
            Sign in to continue
          </p>

          <button
            onClick={() => signIn("google", { callbackUrl: "/" })}
            style={{
              width: "100%",
              padding: "12px 16px",
              background: "var(--zoca-text)",
              color: "#FEF3C7",
              border: "1px solid var(--zoca-text)",
              borderRadius: 10,
              fontFamily: "-apple-system, Inter, system-ui, sans-serif",
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              transition: "background 0.18s ease",
            }}
          >
            <span style={{ color: "#FBBF24", fontWeight: 700 }}>G</span>
            Click to follow
          </button>

          <p
            style={{
              margin: "1rem 0 0",
              fontFamily: "-apple-system, Inter, system-ui, sans-serif",
              fontSize: 11,
              color: "var(--zoca-text-3)",
              textAlign: "center",
              lineHeight: 1.5,
            }}
          >
            Only @zoca.ai and @zoca.com accounts can sign in.
          </p>
        </div>

        <p
          style={{
            marginTop: "4rem",
            fontFamily: "-apple-system, Inter, system-ui, sans-serif",
            fontSize: 11,
            letterSpacing: "3px",
            color: "var(--zoca-text-3)",
          }}
        >
          B E A C O N &nbsp; &middot; &nbsp; B U I L T &nbsp; F O R &nbsp; Z O C A
        </p>
      </div>
    </main>
  );
}
