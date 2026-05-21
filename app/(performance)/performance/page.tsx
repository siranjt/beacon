import Link from "next/link";

export default function PerformanceBeaconPlaceholder() {
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
        Performance Beacon
      </h1>
      <p style={{ color: "var(--zoca-text-2)", maxWidth: 460, textAlign: "center", marginTop: 12 }}>
        Pending migration into the umbrella (Phase B). The live deployment
        continues at{" "}
        <a href="https://zoca-performance-report.vercel.app" style={{ color: "var(--zoca-pink)" }}>
          zoca-performance-report.vercel.app
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
