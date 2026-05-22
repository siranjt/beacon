import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { AGENTS } from "@/lib/config";
import BeaconAmbient from "@/components/BeaconAmbient";
import LauncherCard from "./_components/LauncherCard";
import LauncherSignOut from "./_components/LauncherSignOut";

/**
 * Beacon umbrella launcher — the gateway screen users land on after sign-in.
 *
 * Layout: same Watchfire register as the sign-in page (BeaconAmbient persists
 * at viewport center) + 4 tool cards in a row. Each card shows the agent's
 * name, description, and a current status line. Clicking a card takes you to
 * that agent — external URL today (Phase A), internal route after migration.
 */
export default async function LauncherPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/auth/signin");
  }

  const firstName = (session.user?.name || "").trim().split(/\s+/)[0] || "there";

  return (
    <main style={{ position: "relative", minHeight: "100vh", background: "var(--zoca-bg)" }}>
      <BeaconAmbient />

      {/*
        Sign-out control. Pinned top-right inside the main relative box so it
        sits above the BeaconAmbient backdrop but doesn't shift the centered
        hero layout. Client component — uses NextAuth's signOut(), redirects
        to /auth/signin after token revocation.
      */}
      <LauncherSignOut />

      <div
        style={{
          position: "relative",
          zIndex: 2,
          maxWidth: 1100,
          margin: "0 auto",
          padding: "5rem 1.5rem 4rem",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: "3.5rem" }}>
          <div
            style={{
              fontSize: 12,
              letterSpacing: "2px",
              color: "var(--zoca-text-2)",
              marginBottom: 16,
              fontFamily: "-apple-system, Inter, system-ui, sans-serif",
            }}
          >
            · WELCOME TO BEACON ·
          </div>
          <h1
            style={{
              fontFamily: 'Georgia, "Times New Roman", serif',
              fontSize: "clamp(28px, 4.5vw, 44px)",
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
              fontSize: 16,
              color: "var(--zoca-text-2)",
              margin: 0,
            }}
          >
            Which signal are you following today?
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "1rem",
          }}
        >
          {AGENTS.map((agent) => (
            <LauncherCard key={agent.id} agent={agent} />
          ))}
        </div>

        <div
          style={{
            textAlign: "center",
            marginTop: "3rem",
            fontFamily: "-apple-system, Inter, system-ui, sans-serif",
            fontSize: 11,
            letterSpacing: "3px",
            color: "var(--zoca-text-3)",
          }}
        >
          B E A C O N &nbsp; &middot; &nbsp; B U I L T &nbsp; F O R &nbsp; Z O C A
        </div>
      </div>
    </main>
  );
}
