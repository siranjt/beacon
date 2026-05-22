"use client";
import { useState } from "react";
import type { OneOnOneLogRow } from "@/lib/customer/one-on-one";

type Props = { rows: OneOnOneLogRow[] };

function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso.slice(0, 10);
  const d = new Date(t);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function previewNotes(notes: string | null): string {
  if (!notes) return "(no notes)";
  return notes.length > 80 ? `${notes.slice(0, 80).trim()}…` : notes;
}

export default function V2OneOnOneHistory({ rows }: Props) {
  const [openId, setOpenId] = useState<number | null>(null);
  const opened = openId !== null ? rows.find((r) => r.id === openId) ?? null : null;

  return (
    <section
      className="mb-4 rounded-zoca-lg bg-zoca-bg-soft p-4 md:p-5"
      style={{ border: "0.5px solid var(--zoca-border)" }}
    >
      <header className="mb-2">
        <h2
          className="font-extrabold text-zoca-text"
          style={{ fontSize: "15px", letterSpacing: "-0.01em" }}
        >
          History
        </h2>
        <p className="mt-0.5 text-[11px] text-zoca-text-2">
          Past 1:1s logged for this AM. Click a row to see the full notes.
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-lg bg-[color:var(--zoca-bg-soft)] px-3 py-3 text-[12px] text-zoca-text-2">
          No prior 1:1s logged yet.
        </div>
      ) : (
        <ul className="divide-y" style={{ borderColor: "var(--zoca-border)" }}>
          {rows.map((r) => {
            const actionCount = r.action_items.length;
            const doneCount = r.action_items.filter((a) => a.done).length;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(r.id)}
                  className="flex w-full items-center justify-between gap-3 py-2 text-left transition hover:bg-[color:var(--zoca-bg-soft)]"
                  style={{ background: "transparent", border: 0, cursor: "pointer" }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[12.5px]">
                      <span className="font-semibold text-zoca-text">
                        {fmtDate(r.held_at)}
                      </span>
                      {r.manager_email && (
                        <span className="text-[11px] text-zoca-text-2">
                          · {r.manager_email}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[11.5px] text-zoca-text-2">
                      {previewNotes(r.notes)}
                    </div>
                  </div>
                  <div className="text-[11px] text-zoca-text-2">
                    {doneCount}/{actionCount} done
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {opened && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ background: "rgba(11,5,29,0.45)" }}
          onClick={() => setOpenId(null)}
        >
          <div
            className="max-h-[80vh] w-full max-w-xl overflow-auto rounded-zoca-lg bg-zoca-bg-soft p-5"
            style={{ border: "0.5px solid var(--zoca-border)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3
                  className="font-extrabold text-zoca-text"
                  style={{ fontSize: "17px" }}
                >
                  1:1 — {fmtDate(opened.held_at)}
                </h3>
                {opened.manager_email && (
                  <div className="mt-0.5 text-[11.5px] text-zoca-text-2">
                    Logged by {opened.manager_email}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setOpenId(null)}
                aria-label="Close"
                className="rounded p-1 text-[18px] text-zoca-text-soft transition hover:text-zoca-text"
                style={{ background: "transparent", border: 0, cursor: "pointer" }}
              >
                ×
              </button>
            </div>

            <div className="mt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zoca-text-2">
                Notes
              </div>
              <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-zoca-text">
                {opened.notes || "(no notes)"}
              </p>
            </div>

            <div className="mt-4">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zoca-text-2">
                Action items ({opened.action_items.length})
              </div>
              {opened.action_items.length === 0 ? (
                <div className="mt-1 text-[12px] text-zoca-text-2">
                  None recorded.
                </div>
              ) : (
                <ul className="mt-1 space-y-1">
                  {opened.action_items.map((it, idx) => (
                    <li
                      key={idx}
                      className="flex items-start gap-2 text-[12.5px]"
                      style={{ opacity: it.done ? 0.6 : 1 }}
                    >
                      <span aria-hidden style={{ marginTop: 2 }}>
                        {it.done ? "✓" : "•"}
                      </span>
                      <span className="flex-1 text-zoca-text">
                        <span style={{ textDecoration: it.done ? "line-through" : "none" }}>
                          {it.text}
                        </span>
                        {it.assignee && (
                          <span className="ml-1 text-zoca-text-2">
                            — {it.assignee}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
