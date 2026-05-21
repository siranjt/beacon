"use client";

import Link from "next/link";

const SERIF = 'Georgia, "Times New Roman", "Times", serif';
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif";

const BRASS_DEEP = "#B8852E";
const EMBER = "#C8431D";
const TEXT = "#2B1F14";
const MUTED = "#6E5F50";
const FADED = "#8B7A66";
const BORDER = "#D4C29B";
const SURFACE = "#F8EFD7";

/**
 * Hardcoded sample report cards. Sheila Marie Aesthetics is the canonical
 * "live sample" — the others are visual placeholders that will resolve to
 * the empty-state error if their entity IDs aren't in Aurora. Replace with
 * a real recent-reports table in a follow-up.
 */
const SAMPLES: {
  entityId: string;
  bizname: string;
  vertical: string;
  location: string;
  badge?: string;
  highlight?: boolean;
}[] = [
  {
    entityId: "a24bbd56-42ab-4540-9769-7cf65fadeaa6",
    bizname: "Sheila Marie Aesthetics",
    vertical: "Facial spa",
    location: "San Mateo, CA",
    badge: "live sample",
    highlight: true,
  },
];

export default function RecentReports() {
  return (
    <section style={{ marginBottom: 22 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 10,
        }}
      >
        <div
          style={{
            fontFamily: SANS,
            fontSize: 10,
            letterSpacing: "0.14em",
            color: MUTED,
            fontWeight: 600,
            textTransform: "uppercase",
          }}
        >
          Sample reports
        </div>
        <div
          style={{
            fontFamily: SANS,
            fontSize: 11,
            color: FADED,
          }}
        >
          Click a card to open the full report
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 10,
        }}
      >
        {SAMPLES.map((s) => (
          <Link
            key={s.entityId}
            href={`/performance/report/${s.entityId}`}
            style={{
              textDecoration: "none",
              background: SURFACE,
              border: `${s.highlight ? "2" : "1"}px solid ${s.highlight ? EMBER : BORDER}`,
              borderRadius: 10,
              padding: "12px 14px",
              display: "block",
              transition: "transform 0.15s ease-out, border-color 0.15s ease-out",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div
                style={{
                  fontFamily: SANS,
                  fontSize: 9,
                  letterSpacing: "0.14em",
                  color: s.highlight ? EMBER : BRASS_DEEP,
                  fontWeight: 700,
                  textTransform: "uppercase",
                }}
              >
                {s.vertical}
              </div>
              {s.badge && (
                <div
                  style={{
                    fontFamily: SANS,
                    fontSize: 9,
                    color: EMBER,
                    fontWeight: 600,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                  }}
                >
                  {s.badge}
                </div>
              )}
            </div>
            <div
              style={{
                fontFamily: SERIF,
                fontSize: 15,
                fontWeight: 600,
                marginTop: 4,
                color: TEXT,
              }}
            >
              {s.bizname}
            </div>
            <div
              style={{
                fontFamily: SANS,
                fontSize: 11,
                color: MUTED,
                marginTop: 2,
              }}
            >
              {s.location}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

export { SAMPLES };
