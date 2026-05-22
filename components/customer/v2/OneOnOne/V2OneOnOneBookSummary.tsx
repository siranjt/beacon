"use client";
import type { OneOnOnePrepData } from "@/lib/customer/one-on-one";

type Props = { book: OneOnOnePrepData["book_summary"] };

function fmtMoney(cents: number): string {
  if (!cents) return "$0";
  return `$${Math.round(cents / 100).toLocaleString()}`;
}

export default function V2OneOnOneBookSummary({ book }: Props) {
  const totalSafe = book.total || 1;
  const redPct = Math.round((book.red / totalSafe) * 100);
  return (
    <section
      className="mb-4 rounded-zoca-lg bg-zoca-bg-soft p-4 md:p-5"
      style={{ border: "0.5px solid var(--zoca-border)" }}
    >
      <h2
        className="font-extrabold text-zoca-text"
        style={{ fontSize: "15px", letterSpacing: "-0.01em" }}
      >
        Book summary
      </h2>
      <p className="mt-0.5 text-[11px] text-zoca-text-2">
        Active book at last refresh.
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px] md:grid-cols-4">
        <Stat label="Accounts" value={book.total} />
        <Stat label="MRR managed" value={fmtMoney(book.mrr_total_cents)} />
        <Stat
          label="Needs call"
          value={`${book.red} (${redPct}%)`}
          color="var(--zoca-pink)"
        />
        <Stat
          label="MRR at risk"
          value={fmtMoney(book.mrr_at_risk_cents)}
          color="var(--zoca-pink)"
        />
      </dl>
    </section>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div>
      <dt
        className="text-[10.5px] uppercase tracking-wider text-zoca-text-2"
        style={{ letterSpacing: "0.04em" }}
      >
        {label}
      </dt>
      <dd
        className="mt-0.5 tabular-nums font-extrabold"
        style={{ fontSize: "16px", color: color ?? "var(--zoca-text)" }}
      >
        {value}
      </dd>
    </div>
  );
}
