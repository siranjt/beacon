import Link from "next/link";

export default function PostPaymentBeaconPlaceholder() {
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
        Post-Payment Reviews
      </h1>
      <p style={{ color: "var(--zoca-text-2)", maxWidth: 460, textAlign: "center", marginTop: 12 }}>
        Pending migration into the umbrella (Phase D). The live deployment
        continues at{" "}
        <a href="https://zoca-payment-dashboard.vercel.app" style={{ color: "var(--zoca-pink)" }}>
          zoca-payment-dashboard.vercel.app
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
