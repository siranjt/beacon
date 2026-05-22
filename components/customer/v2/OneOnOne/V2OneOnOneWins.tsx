"use client";
import type { OneOnOneWin } from "@/lib/customer/one-on-one";

type Props = { wins: OneOnOneWin[] };

const STOPLIGHT_TONES: Record<
  "RED" | "YELLOW" | "GREEN",
  { fg: string; bg: string }
> = {
  RED: { fg: "#e11d48", bg: "rgba(244,63,94,0.08)" },
  YELLOW: { fg: "#b45309", bg: "rgba(245,158,11,0.08)" },
  GREEN: { fg: "#047857", bg: "rgba(16,185,129,0.08)" },
};

function StoplightChip({ sl }: { sl: "RED" | "YELLOW" | "GREEN" }) {
  const t = STOPLIGHT_TONES[sl];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{ color: t.fg, background: t.bg, border: `1px solid ${t.fg}22` }}
    >
      {sl}
    </span>
  );
}

export default function V2OneOnOneWins({ wins }: Props) {
  return (
    <section
      className="mb-4 rounded-zoca-lg bg-zoca-bg-soft p-4 md:p-5"
      style={{ border: "0.5px solid var(--zoca-border)" }}
    >
      <h2
        className="font-extrabold text-zoca-text"
        style={{ fontSize: "15px", letterSpacing: "-0.01em" }}
      >
        Wins since last 1:1
      </h2>
      <p className="mt-0.5 text-[11px] text-zoca-text-2">
        Customers that moved up a stoplight since the previous 1:1 (or 7 days
        ago if this is the first).
      </p>

      {wins.length === 0 ? (
        <div className="mt-3 rounded-lg bg-[color:var(--zoca-bg-soft)] px-3 py-3 text-[12px] text-zoca-text-2">
          No stoplight recoveries to call out yet — worth digging into what's
          stuck.
        </div>
      ) : (
        <ul className="mt-3 divide-y" style={{ borderColor: "var(--zoca-border)" }}>
          {wins.map((w) => (
            <li
              key={w.entity_id}
              className="flex items-center justify-between gap-3 py-2 text-[12.5px]"
            >
              <a
                href={`/customer/customer/${encodeURIComponent(w.entity_id)}`}
                className="font-semibold text-zoca-text hover:text-zoca-blue"
                style={{ textDecoration: "none" }}
              >
                {w.bizname || w.entity_id.slice(0, 8)}
              </a>
              <span className="inline-flex items-center gap-1.5">
                <StoplightChip sl={w.previous_stoplight} />
                <span className="text-zoca-text-2">→</span>
                <StoplightChip sl={w.current_stoplight} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
