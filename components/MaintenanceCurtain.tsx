/**
 * MaintenanceCurtain — full-page lock screen for agents that are temporarily
 * pulled offline. Wraps `BeaconPageShell` so the watchfire backdrop and brand
 * register stay consistent with the rest of the umbrella.
 *
 * Used by route-group layouts under `app/(performance)/layout.tsx` and
 * `app/(post-payment)/layout.tsx`. The layouts gate on `LOCKED_AGENTS` from
 * `lib/config.ts` and render this component instead of `{children}` when the
 * agent is locked.
 *
 * Applies to EVERYONE — admins included. There is no role override; the curtain
 * shows uniformly. Unlocking is a config-flag flip in `lib/config.ts`, not a
 * per-user bypass.
 */

import Link from "next/link";
import BeaconPageShell from "@/components/BeaconPageShell";

interface Props {
  /** Human-readable agent name — appears in the heading. */
  agentName: string;
  /** Optional secondary line under the heading. */
  detail?: string;
}

export default function MaintenanceCurtain({ agentName, detail }: Props) {
  return (
    <BeaconPageShell>
      <main
        style={{
          minHeight: "calc(100vh - 80px)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "4rem 1.5rem",
          textAlign: "center",
          fontFamily: 'Georgia, "Times New Roman", serif',
          color: "var(--zoca-text)",
        }}
      >
        {/* Brass divider accent — anchors the eye on the headline. */}
        <div
          aria-hidden
          style={{
            width: 48,
            height: 2,
            background: "var(--zoca-brass, #D9A441)",
            opacity: 0.75,
            marginBottom: 32,
          }}
        />

        <div
          style={{
            fontFamily: "-apple-system, Inter, system-ui, sans-serif",
            fontSize: 11,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: "var(--zoca-text-3)",
            marginBottom: 18,
          }}
        >
          Beacon · maintenance
        </div>

        <h1
          style={{
            fontSize: "clamp(28px, 4.5vw, 44px)",
            fontWeight: 500,
            letterSpacing: "-0.012em",
            lineHeight: 1.15,
            margin: 0,
            maxWidth: 720,
          }}
        >
          {agentName} will be operational shortly.
        </h1>

        <p
          style={{
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontStyle: "italic",
            fontSize: 17,
            color: "var(--zoca-text-2)",
            margin: "20px auto 0",
            maxWidth: 560,
            lineHeight: 1.55,
          }}
        >
          {detail ??
            "We're polishing this view. Check back soon — the rest of Beacon is unaffected."}
        </p>

        <div style={{ marginTop: 40, display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center" }}>
          <Link
            href="/"
            style={{
              padding: "0.7rem 1.4rem",
              borderRadius: 10,
              border: "1px solid var(--zoca-border)",
              background: "var(--zoca-bg)",
              color: "var(--zoca-text)",
              textDecoration: "none",
              fontFamily: "-apple-system, Inter, system-ui, sans-serif",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            ← Back to launcher
          </Link>
        </div>

        <div
          style={{
            marginTop: 56,
            fontFamily: "-apple-system, Inter, system-ui, sans-serif",
            fontSize: 11,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "var(--zoca-text-3)",
            opacity: 0.7,
          }}
        >
          The flame still burns.
        </div>
      </main>
    </BeaconPageShell>
  );
}
