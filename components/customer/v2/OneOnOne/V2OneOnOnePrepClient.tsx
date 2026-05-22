"use client";
import { useCallback, useEffect, useState } from "react";
import type {
  OneOnOnePrepData,
  OneOnOneLogRow,
  TalkingPoint,
  OneOnOneActionItem,
} from "@/lib/customer/one-on-one";
import V2OneOnOneHeader from "./V2OneOnOneHeader";
import V2OneOnOneBookSummary from "./V2OneOnOneBookSummary";
import V2OneOnOneActionsRecap from "./V2OneOnOneActionsRecap";
import V2OneOnOneWins from "./V2OneOnOneWins";
import V2OneOnOneCoaching from "./V2OneOnOneCoaching";
import V2OneOnOneTalkingPoints from "./V2OneOnOneTalkingPoints";
import V2OneOnOneNotes from "./V2OneOnOneNotes";
import V2OneOnOneHistory from "./V2OneOnOneHistory";

type Props = { amName: string };

export default function V2OneOnOnePrepClient({ amName }: Props) {
  const [prep, setPrep] = useState<OneOnOnePrepData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enriched, setEnriched] = useState<TalkingPoint[] | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [history, setHistory] = useState<OneOnOneLogRow[]>([]);
  const [usedIds, setUsedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Fetch prep
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/v2/manager/1on1/${encodeURIComponent(amName)}`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (cancelled) return;
        if (!data.ok) {
          setError(data.error || `HTTP ${res.status}`);
          setLoading(false);
          return;
        }
        setPrep(data.prep as OneOnOnePrepData);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [amName]);

  // Fetch history (independent of prep payload, runs in parallel)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/v2/manager/1on1/${encodeURIComponent(amName)}/history?limit=20`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (cancelled) return;
        if (data.ok) {
          setHistory((data.rows ?? []) as OneOnOneLogRow[]);
        }
      } catch {
        // history is best-effort; ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [amName]);

  const handleEnrich = useCallback(async () => {
    if (!prep) return;
    setEnriching(true);
    try {
      const res = await fetch(
        `/api/v2/manager/1on1/${encodeURIComponent(amName)}/enrich`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rules: prep.talking_points_rule_based,
            context_lite: {
              am_name: prep.am_name,
              pod: prep.pod,
              book_summary: prep.book_summary,
              actions_last_7d: prep.actions_last_7d,
              coaching: prep.coaching,
            },
          }),
        },
      );
      const data = await res.json();
      if (data.ok && Array.isArray(data.points)) {
        setEnriched(data.points as TalkingPoint[]);
      }
    } catch {
      // soft-fail — keep rule-based
    } finally {
      setEnriching(false);
    }
  }, [amName, prep]);

  const handleToggleUsed = useCallback((id: string) => {
    setUsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSave = useCallback(
    async (payload: {
      notes: string;
      action_items: OneOnOneActionItem[];
      manager_email: string;
    }) => {
      if (!prep) return;
      setSaving(true);
      setToast(null);
      try {
        const res = await fetch(
          `/api/v2/manager/1on1/${encodeURIComponent(amName)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              manager_email: payload.manager_email || undefined,
              notes: payload.notes || undefined,
              action_items: payload.action_items,
              talking_points_used: Array.from(usedIds),
            }),
          },
        );
        const data = await res.json();
        if (!data.ok) {
          setToast(`Save failed: ${data.error || `HTTP ${res.status}`}`);
        } else {
          setToast("Saved.");
          setUsedIds(new Set());
          // Refresh history
          try {
            const histRes = await fetch(
              `/api/v2/manager/1on1/${encodeURIComponent(amName)}/history?limit=20`,
              { cache: "no-store" },
            );
            const histData = await histRes.json();
            if (histData.ok) {
              setHistory((histData.rows ?? []) as OneOnOneLogRow[]);
            }
          } catch {
            // best-effort
          }
          // Hide toast after a moment
          setTimeout(() => setToast(null), 3500);
        }
      } catch (e) {
        setToast(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSaving(false);
      }
    },
    [amName, prep, usedIds],
  );

  const displayedPoints = enriched ?? prep?.talking_points_rule_based ?? [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <nav className="mb-3 text-[11.5px] text-zoca-text-2">
        <a href="/customer/manager" className="hover:text-zoca-blue">
          ← Back to Manager view
        </a>
        <span className="mx-1">/</span>
        <a href="/customer/manager/1on1" className="hover:text-zoca-blue">
          1:1 prep
        </a>
        <span className="mx-1">/</span>
        <span className="font-semibold text-zoca-text">{amName}</span>
      </nav>

      {loading && (
        <div
          className="rounded-zoca-lg bg-zoca-bg-soft p-6 text-center text-[12px] text-zoca-text-2"
          style={{ border: "0.5px solid var(--zoca-border)" }}
        >
          Loading 1:1 prep for {amName}…
        </div>
      )}

      {error && (
        <div
          className="rounded-zoca-lg bg-zoca-bg-soft p-6 text-center text-[12.5px]"
          style={{
            border: "0.5px solid rgba(244,63,94,0.22)",
            color: "var(--zoca-pink)",
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && prep && (
        <>
          <V2OneOnOneHeader
            amName={prep.am_name}
            pod={prep.pod}
            last={prep.last_one_on_one}
            book={prep.book_summary}
          />

          <div className="grid grid-cols-1 gap-0 lg:grid-cols-2 lg:gap-4">
            <div className="lg:col-span-1">
              <V2OneOnOneBookSummary book={prep.book_summary} />
              <V2OneOnOneActionsRecap actions={prep.actions_last_7d} />
              <V2OneOnOneWins wins={prep.wins_since_last_one_on_one} />
            </div>
            <div className="lg:col-span-1">
              <V2OneOnOneCoaching amName={prep.am_name} row={prep.coaching} />
              <V2OneOnOneTalkingPoints
                points={displayedPoints}
                onEnrich={handleEnrich}
                enriching={enriching}
                enrichedAlready={!!enriched}
                onToggleUsed={handleToggleUsed}
                usedIds={usedIds}
              />
            </div>
          </div>

          <V2OneOnOneNotes saving={saving} onSave={handleSave} />
          <V2OneOnOneHistory rows={history} />

          {toast && (
            <div
              role="status"
              className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full px-4 py-2 text-[12.5px] font-semibold"
              style={{
                background: "var(--zoca-text)",
                color: "#fff",
                boxShadow: "0 4px 16px rgba(11,5,29,0.18)",
                zIndex: 60,
              }}
            >
              {toast}
            </div>
          )}
        </>
      )}
    </div>
  );
}
