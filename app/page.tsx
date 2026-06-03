import { redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { AGENTS } from "@/lib/config";
import { getRoleForEmail } from "@/lib/customer/config";
import BeaconAmbient from "@/components/BeaconAmbient";
import LauncherCard from "./_components/LauncherCard";
import LauncherSignOut from "./_components/LauncherSignOut";
import InboxFeed from "./_components/InboxFeed";
import SuggestedActions from "@/components/ai/SuggestedActions";

/**
 * Beacon umbrella launcher — Phase E-9 "action inbox" rework.
 *
 * Primary surface is now the InboxFeed (today's queue across all four
 * agents). The original 4-card agent grid demotes to a thin "or jump
 * directly to" row underneath. BeaconAmbient still floats at viewport
 * center for the brand register.
 *
 * Why: AMs land here every morning and need to start with "what needs my
 * attention?" not "which tool should I open?". The inbox answers the
 * first question; the card row stays for exploratory navigation when
 * there's nothing urgent.
 */
export default async function LauncherPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/auth/signin");
  }

  const firstName = (session.user?.name || "").trim().split(/\s+/)[0] || "there";
  const isAdmin = getRoleForEmail(session.user?.email ?? "") === "admin";

  return (
    <main style={{ position: "relative", minHeight: "100vh", background: "var(--zoca-bg)" }}>
      <BeaconAmbient />

      {/*
        Sign-out control. Pinned top-right inside the main relative box so it
        sits above the BeaconAmbient backdrop but doesn't shift the centered
        hero layout.
      */}
      <LauncherSignOut />

      <div
        style={{
          position: "relative",
          zIndex: 2,
          maxWidth: 720,
          margin: "0 auto",
          padding: "4rem 1.5rem 6rem",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: "2.5rem" }}>
          <div
            style={{
              fontSize: 12,
              letterSpacing: "2px",
              color: "var(--zoca-text-2)",
              marginBottom: 16,
              fontFamily: "-apple-system, Inter, system-ui, sans-serif",
            }}
          >
            · TODAY ·
          </div>
          <h1
            style={{
              fontFamily: 'Georgia, "Times New Roman", serif',
              fontSize: "clamp(26px, 4vw, 38px)",
              fontWeight: 400,
              letterSpacing: "-0.015em",
              color: "var(--zoca-text)",
              margin: "0 0 0.5rem",
            }}
          >
            Welcome back, {firstName}.
          </h1>
          <p
            style={{
              fontFamily: 'Georgia, "Times New Roman", serif',
              fontStyle: "italic",
              fontSize: 15,
              color: "var(--zoca-text-2)",
              margin: 0,
            }}
          >
            Here&apos;s what needs your attention.
          </p>
        </div>

        {/* Phase E-9 — Beacon AI proactive recommendations strip. Sits
            above the inbox so the user sees "what should I focus on" as
            their first read. */}
        <SuggestedActions scope={{ kind: "inbox" }} />

        {/* Primary surface — today's inbox */}
        <InboxFeed />

        {/* Secondary — agent jump cards (smaller, lower visual weight) */}
        <div
          style={{
            marginTop: "3rem",
            paddingTop: "1.5rem",
            borderTop: "1px solid var(--zoca-border)",
          }}
        >
          <div
            style={{
              fontFamily: "-apple-system, Inter, system-ui, sans-serif",
              fontSize: 11,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--zoca-text-3)",
              marginBottom: "0.75rem",
              textAlign: "center",
            }}
          >
            Or jump directly to
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: "0.75rem",
            }}
          >
            {AGENTS.map((agent) => (
              <LauncherCard key={agent.id} agent={agent} />
            ))}
          </div>
        </div>

        {/* Subtle Cmd+K + ? hints */}
        <div
          style={{
            marginTop: "2rem",
            textAlign: "center",
            fontFamily: "-apple-system, Inter, system-ui, sans-serif",
            fontSize: 11,
            color: "var(--zoca-text-3)",
            display: "flex",
            justifyContent: "center",
            gap: 18,
            flexWrap: "wrap",
          }}
        >
          <span>
            <kbd style={kbdStyle}>⌘K</kbd> to jump to any customer&apos;s 360
          </span>
          <span>
            <kbd style={kbdStyle}>?</kbd> for all keyboard shortcuts
          </span>
          {isAdmin && (
            <>
              <Link
                href="/admin/activity"
                style={{
                  color: "var(--zoca-text-2)",
                  textDecoration: "none",
                  borderBottom: "1px dotted var(--zoca-text-3)",
                }}
              >
                Admin · Activity log
              </Link>
              <Link
                href="/admin/knowledge"
                style={{
                  color: "var(--zoca-text-2)",
                  textDecoration: "none",
                  borderBottom: "1px dotted var(--zoca-text-3)",
                }}
              >
                Admin · Knowledge base
              </Link>
            </>
          )}
        </div>
      </div>

      {/*
        Phase E-7 polish — "BEACON · BUILT FOR ZOCA" tagline pinned to the
        bottom of the viewport so it reads as a footer.
      */}
      <div
        style={{
          position: "absolute",
          bottom: "1.5rem",
          left: 0,
          right: 0,
          textAlign: "center",
          fontFamily: "-apple-system, Inter, system-ui, sans-serif",
          fontSize: 11,
          letterSpacing: "3px",
          color: "var(--zoca-text-3)",
          pointerEvents: "none",
          zIndex: 2,
        }}
      >
        B E A C O N &nbsp; &middot; &nbsp; B U I L T &nbsp; F O R &nbsp; Z O C A
      </div>
    </main>
  );
}

const kbdStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
  fontSize: 10,
  padding: "1px 5px",
  border: "1px solid var(--zoca-border)",
  borderRadius: 4,
  background: "var(--zoca-surface)",
};
