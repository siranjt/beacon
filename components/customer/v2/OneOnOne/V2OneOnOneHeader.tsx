"use client";
import type { OneOnOnePrepData, OneOnOneLogRow } from "@/lib/customer/one-on-one";

type Props = {
  amName: string;
  pod: string | null;
  last: OneOnOneLogRow | null;
  book: OneOnOnePrepData["book_summary"];
};

function fmtMoney(cents: number): string {
  if (!cents) return "$0";
  return `$${Math.round(cents / 100).toLocaleString()}`;
}

function daysSince(iso: string | null): { label: string; tone: string } {
  if (!iso) return { label: "No prior 1:1 logged", tone: "var(--zoca-text-soft)" };
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return { label: "No prior 1:1 logged", tone: "var(--zoca-text-soft)" };
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return { label: "Today", tone: "#047857" };
  if (days === 1) return { label: "1 day since last 1:1", tone: "#047857" };
  if (days < 14) return { label: `${days} days since last 1:1`, tone: "#047857" };
  if (days < 30) return { label: `${days} days since last 1:1`, tone: "#b45309" };
  return { label: `${days} days since last 1:1`, tone: "#e11d48" };
}

export default function V2OneOnOneHeader({ amName, pod, last, book }: Props) {
  const d = daysSince(last?.held_at ?? null);
  return (
    <header
      className="mb-4 rounded-zoca-lg bg-zoca-bg-soft p-4 md:p-5"
      style={{ border: "0.5px solid var(--zoca-border)" }}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1
            className="font-extrabold text-zoca-text"
            style={{ fontSize: "22px", letterSpacing: "-0.02em" }}
          >
            {amName}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-zoca-text-2">
            {pod && (
              <span
                className="rounded-full px-2 py-0.5 text-[10.5px] uppercase tracking-wider"
                style={{
                  background: "var(--zoca-bg-soft)",
                  border: "1px solid var(--zoca-border)",
                  letterSpacing: "0.04em",
                }}
              >
                {pod}
              </span>
            )}
            <span style={{ color: d.tone, fontWeight: 600 }}>{d.label}</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Chip color="#e11d48" bg="rgba(244,63,94,0.08)" label="Needs call" value={book.red} />
          <Chip
            color="#b45309"
            bg="rgba(245,158,11,0.08)"
            label="Monitor"
            value={book.yellow}
          />
          <Chip
            color="#047857"
            bg="rgba(16,185,129,0.08)"
            label="Healthy"
            value={book.green}
          />
          <Chip
            color="var(--zoca-text)"
            bg="var(--zoca-bg-soft)"
            label="MRR"
            value={fmtMoney(book.mrr_total_cents)}
          />
        </div>
      </div>
    </header>
  );
}

function Chip({
  color,
  bg,
  label,
  value,
}: {
  color: string;
  bg: string;
  label: string;
  value: number | string;
}) {
  return (
    <span
      className="inline-flex items-baseline gap-1.5 rounded-full px-3 py-1 text-[12px]"
      style={{ background: bg, color, border: `1px solid ${color}22` }}
    >
      <span className="font-extrabold tabular-nums">{value}</span>
      <span className="text-[10.5px] uppercase tracking-wider opacity-80">
        {label}
      </span>
    </span>
  );
}
