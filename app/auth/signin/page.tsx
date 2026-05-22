"use client";

// Phase E-7 polish — Beacon umbrella sign-in, "Follow the Light".
//
// Restored from v1 Customer Beacon (beacon-zoca.vercel.app) so the umbrella's
// front door reads the same: heraldic Watchfire palette, Georgia serif
// wordmark, 4-layer animated flame, 4 staggered pulse rings, 6 rising embers,
// gold Google G. NextAuth wiring preserved (Suspense + useSearchParams +
// signIn + error banners + loading state).

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import ZocaLogo from "@/components/ZocaLogo";

const C = {
  parchment: "#F0E4CC",
  parchmentLight: "#F8EFD7",
  agedBrass: "#D4C29B",
  char: "#2B1F14",
  smoke: "#6E5F50",
  fadedSmoke: "#8B7A66",
  ember: "#C8431D",
  deepOrange: "#E85A2B",
  brass: "#D9A441",
  gold: "#FBBF24",
  cream: "#FEF3C7",
  haloOuter: "#FDE68A",
  haloInner: "#FCD34D",
};

export default function SignInPage() {
  return (
    <Suspense fallback={<SignInShell />}>
      <SignInPageInner />
    </Suspense>
  );
}

function SignInPageInner() {
  const params = useSearchParams();
  const error = params.get("error");
  // Default to "/" (the umbrella launcher) — was "/v2" in standalone v1.
  const callbackUrl = params.get("callbackUrl") || "/";
  return <SignInShell error={error} callbackUrl={callbackUrl} />;
}

function SignInShell({
  error,
  callbackUrl = "/",
}: {
  error?: string | null;
  callbackUrl?: string;
}) {
  const [loading, setLoading] = useState(false);
  return (
    <div
      style={{
        minHeight: "100vh",
        background: C.parchment,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        overflow: "hidden",
        padding: "24px",
        fontFamily:
          'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      {/* Zoca brand attribution top-left. */}
      <div
        style={{
          position: "absolute",
          top: "24px",
          left: "32px",
          zIndex: 20,
          opacity: 0.85,
        }}
      >
        <ZocaLogo height={20} fill={C.char} />
      </div>

      <div
        style={{
          position: "relative",
          zIndex: 10,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <Scene />
        <h1
          style={{
            margin: 0,
            fontSize: "44px",
            fontWeight: 400,
            letterSpacing: "0.5em",
            paddingLeft: "0.5em",
            color: C.char,
            fontFamily: 'Georgia, "Times New Roman", serif',
          }}
        >
          BEACON
        </h1>

        <p
          style={{
            margin: "8px 0 0",
            fontSize: "11px",
            letterSpacing: "0.25em",
            color: C.smoke,
          }}
        >
          A &nbsp; S I G N A L &nbsp; W O R T H &nbsp; F O L L O W I N G
        </p>

        <SparkleDivider />

        <div
          style={{
            marginTop: "20px",
            background: C.parchmentLight,
            border: `1px solid ${C.agedBrass}`,
            borderRadius: "14px",
            padding: "28px 50px",
            maxWidth: "360px",
            width: "100%",
            textAlign: "center",
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: "18px",
              fontWeight: 400,
              color: C.char,
              fontFamily: 'Georgia, "Times New Roman", serif',
            }}
          >
            Follow the signal
          </h2>
          <p
            style={{
              margin: "4px 0 0",
              fontSize: "11px",
              color: C.smoke,
            }}
          >
            Sign in to continue
          </p>

          {/* Error banners — preserve Phase 33.A behavior */}
          {error === "AccessDenied" && (
            <div
              role="alert"
              style={{
                marginTop: "16px",
                padding: "10px 12px",
                borderRadius: "8px",
                background: "rgba(200, 67, 29, 0.10)",
                border: `1px solid ${C.ember}`,
                color: C.ember,
                fontSize: "11.5px",
                lineHeight: 1.5,
                textAlign: "left",
              }}
            >
              Your email isn&apos;t on the Zoca team. Contact your manager if this is unexpected.
            </div>
          )}
          {error && error !== "AccessDenied" && (
            <div
              role="alert"
              style={{
                marginTop: "16px",
                padding: "10px 12px",
                borderRadius: "8px",
                background: "rgba(217, 164, 65, 0.12)",
                border: `1px solid ${C.brass}`,
                color: C.char,
                fontSize: "11.5px",
                lineHeight: 1.5,
                textAlign: "left",
              }}
            >
              Couldn&apos;t sign in: {error}. Try again, or contact your manager.
            </div>
          )}

          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              void signIn("google", { callbackUrl });
            }}
            className="beacon-button"
            style={{
              position: "relative",
              marginTop: "20px",
              width: "100%",
              height: "44px",
              borderRadius: "10px",
              background: C.char,
              color: C.parchment,
              border: "none",
              fontSize: "13px",
              fontWeight: 500,
              fontFamily: "inherit",
              cursor: loading ? "wait" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "12px",
            }}
          >
            <GoldGoogleG />
            {loading ? "Catching the signal…" : "Click to follow"}
          </button>

          <hr
            style={{
              margin: "20px 0",
              border: "none",
              borderTop: `1px solid ${C.agedBrass}`,
            }}
          />

          <p
            style={{
              margin: 0,
              fontSize: "11px",
              color: C.smoke,
            }}
          >
            Only @zoca.ai and @zoca.com accounts can sign in.
          </p>
        </div>
      </div>

      <p
        className="beacon-footer-fade"
        style={{
          position: "absolute",
          bottom: "24px",
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: "10px",
          letterSpacing: "0.3em",
          color: C.fadedSmoke,
          opacity: 0,
          pointerEvents: "none",
        }}
      >
        B E A C O N &nbsp; &middot; &nbsp; B U I L T &nbsp; F O R &nbsp; Z O C A
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * The Scene — pulse rings + halo + animated flame + rising embers.
 * All decorative, aria-hidden, pointer-events:none.
 * ───────────────────────────────────────────────────────────── */
function Scene() {
  return (
    <svg
      // Alignment fix from v1: viewBox windowed onto the mark area; rings
      // still extend outward via overflow:visible.
      viewBox="200 60 240 220"
      width="240"
      height="220"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      style={{
        display: "block",
        overflow: "visible",
        pointerEvents: "none",
      }}
    >
      <defs>
        <linearGradient id="beacon-flame-heart" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FEF3C7" />
          <stop offset="100%" stopColor="#FBBF24" />
        </linearGradient>
      </defs>

      {/* Pulse rings — 4 concentric, staggered by 1.25s. r grows 60→240, opacity 0.5→0. */}
      {[0, 1.25, 2.5, 3.75].map((begin, i) => (
        <circle
          key={i}
          cx="320"
          cy="220"
          fill="none"
          stroke="#C8431D"
          strokeWidth="1"
          r="60"
          opacity="0"
        >
          <animate
            attributeName="r"
            values="60;240"
            dur="5s"
            begin={`${begin}s`}
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.5;0"
            dur="5s"
            begin={`${begin}s`}
            repeatCount="indefinite"
          />
        </circle>
      ))}

      {/* Halo — outer + inner, breath loops */}
      <circle cx="320" cy="220" r="48" fill="#FDE68A" opacity="0.18">
        <animate attributeName="r" values="48;58;48" dur="2.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.18;0.34;0.18" dur="2.4s" repeatCount="indefinite" />
      </circle>
      <circle cx="320" cy="220" r="30" fill="#FCD34D" opacity="0.25">
        <animate attributeName="r" values="30;38;30" dur="1.8s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.25;0.42;0.25" dur="1.8s" repeatCount="indefinite" />
      </circle>

      {/* Tower (static) — 4 stepped tiers, mark base at (320, 250) */}
      <g transform="translate(320, 250)">
        <rect x="-12" y="-8"  width="24" height="8" fill="#2B1F14" />
        <rect x="-10" y="-20" width="20" height="8" fill="#2B1F14" />
        <rect x="-8"  y="-32" width="16" height="8" fill="#2B1F14" />
        <rect x="-6"  y="-44" width="12" height="8" fill="#2B1F14" />

        {/* Flame layer 1 — Outer ember, 2.2s flicker */}
        <path
          d="M 0 -82 C 11 -72 14 -60 8 -47 L -8 -47 C -14 -60 -11 -72 0 -82 Z"
          fill="#C8431D"
          className="beacon-flame-1"
          style={{ transformBox: "fill-box", transformOrigin: "center bottom" }}
        />
        {/* Flame layer 2 — Mid deep-orange, 1.7s flicker */}
        <path
          d="M 0 -74 C 7 -66 9 -56 5 -49 L -5 -49 C -9 -56 -7 -66 0 -74 Z"
          fill="#E85A2B"
          className="beacon-flame-2"
          style={{ transformBox: "fill-box", transformOrigin: "center bottom" }}
        />
        {/* Flame layer 3 — Core brass, 1.3s flicker */}
        <path
          d="M 0 -68 C 4 -62 6 -54 3 -50 L -3 -50 C -6 -54 -4 -62 0 -68 Z"
          fill="#D9A441"
          className="beacon-flame-3"
          style={{ transformBox: "fill-box", transformOrigin: "center bottom" }}
        />
        {/* Flame layer 4 — Heart gradient, 0.9s flicker */}
        <path
          d="M 0 -62 C 2 -58 3 -54 1.5 -51 L -1.5 -51 C -3 -54 -2 -58 0 -62 Z"
          fill="url(#beacon-flame-heart)"
          className="beacon-flame-4"
          style={{ transformBox: "fill-box", transformOrigin: "center bottom" }}
        />
      </g>

      {/* Rising embers — 6 with co-prime durations + delays */}
      <circle cx="320" cy="200" r="1.6" fill="#C8431D" className="beacon-ember-1" />
      <circle cx="320" cy="200" r="1.8" fill="#FBBF24" className="beacon-ember-5" />
      <circle cx="320" cy="200" r="1.5" fill="#E85A2B" className="beacon-ember-2" />
      <circle cx="320" cy="200" r="1.4" fill="#D9A441" className="beacon-ember-3" />
      <circle cx="320" cy="200" r="1.5" fill="#E85A2B" className="beacon-ember-6" />
      <circle cx="320" cy="200" r="1.6" fill="#C8431D" className="beacon-ember-4" />
    </svg>
  );
}

/* Heraldic 8-point sparkle divider between motto and card */
function SparkleDivider() {
  return (
    <div
      aria-hidden="true"
      style={{
        marginTop: "20px",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        width: "200px",
      }}
    >
      <span style={{ flex: 1, height: "0.5px", background: "#D4C29B" }} />
      <svg width="14" height="14" viewBox="-7 -7 14 14">
        <path
          d="M 0 -6 L 1.2 -1.2 L 6 0 L 1.2 1.2 L 0 6 L -1.2 1.2 L -6 0 L -1.2 -1.2 Z"
          fill="#D9A441"
        />
      </svg>
      <span style={{ flex: 1, height: "0.5px", background: "#D4C29B" }} />
    </div>
  );
}

/* Single-color brass "G" — per spec §8 (Google brand-guideline deviation
 * accepted by product; OAuth app is Internal-only). */
function GoldGoogleG() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#FBBF24"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A10.997 10.997 0 0 0 12 23z"
        fill="#FBBF24"
      />
      <path
        d="M5.84 14.1A6.6 6.6 0 0 1 5.49 12c0-.73.13-1.44.35-2.1V7.06H2.18A10.997 10.997 0 0 0 1 12c0 1.77.43 3.45 1.18 4.94l3.66-2.84z"
        fill="#FBBF24"
      />
      <path
        d="M12 5.38c1.62 0 3.07.56 4.21 1.65l3.16-3.16C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
        fill="#FBBF24"
      />
    </svg>
  );
}
