import Link from "next/link";

/**
 * Customer Beacon — placeholder.
 *
 * Phase A: external link. The card on the launcher routes users to
 * https://beacon-zoca.vercel.app (v1 live, unchanged).
 *
 * Phase B (later): the v1 dashboard code lives here under
 * `app/(customer)/`, with route paths like /customer, /customer/manager, etc.
 */
export default function CustomerBeaconPlaceholder() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
      }}
    >
      <h1
        style={{
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontSize: 32,
          color: "var(--zoca-text)",
          margin: 0,
        }}
      >
        Customer Beacon
      </h1>
      <p style={{ color: "var(--zoca-text-2)", maxWidth: 460, textAlign: "center", marginTop: 12 }}>
        Pending migration into the umbrella (Phase B). The live v1 deployment
        continues at{" "}
        <a href="https://beacon-zoca.vercel.app" style={{ color: "var(--zoca-pink)" }}>
          beacon-zoca.vercel.app
        </a>
        .
      </p>
      <Link
        href="/"
        style={{
          marginTop: 24,
          fontSize: 13,
          color: "var(--zoca-pink)",
          textDecoration: "none",
        }}
      >
        ← Back to Beacon
      </Link>
    </main>
  );
}
