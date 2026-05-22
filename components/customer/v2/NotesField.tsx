"use client";

import { useEffect, useRef, useState } from "react";
import { useActivityLogger } from "@/hooks/use-activity-logger";

/**
 * Phase 18.B — private notes per (AM, customer).
 *
 * Self-contained editor rendered inside V2CustomerCard's "Why?" expand.
 * Lazy-fetches the saved note on mount, auto-saves on blur, and shows a
 * compact save-state indicator below the textarea.
 *
 * Note text persists per-AM per-entity in Postgres via /api/v2/notes/:entityId.
 */

type Props = {
  amName: string;
  entityId: string;
  customerId: string | null;
  bizname: string | null;
};

type SaveState = "idle" | "loading" | "saving" | "saved" | "error";

function relativeAge(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function NotesField({ amName, entityId, customerId, bizname }: Props) {
  const [note, setNote] = useState<string>("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>("loading");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const lastSavedRef = useRef<string>("");
  const [, setTick] = useState(0); // re-render so "Saved · Xs ago" ticks up
  const logEvent = useActivityLogger();

  // Load existing note on mount / when key inputs change
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setErrMsg(null);
    fetch(
      `/api/v2/notes/${encodeURIComponent(entityId)}?am=${encodeURIComponent(amName)}`,
    )
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (!data.ok) {
          setState("error");
          setErrMsg(data.error || "Failed to load note");
          return;
        }
        const loaded = (data.note as string) ?? "";
        setNote(loaded);
        setUpdatedAt((data.updated_at as string | null) ?? null);
        lastSavedRef.current = loaded;
        setState("idle");
      })
      .catch((e) => {
        if (cancelled) return;
        setState("error");
        setErrMsg(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [amName, entityId]);

  // Tick every 15s so the relative-time stamp under "Saved" updates live
  useEffect(() => {
    if (state !== "saved") return;
    const id = setInterval(() => setTick((t) => t + 1), 15000);
    return () => clearInterval(id);
  }, [state]);

  async function handleSave() {
    if (note === lastSavedRef.current) return; // nothing to save
    setState("saving");
    setErrMsg(null);
    try {
      const res = await fetch(
        `/api/v2/notes/${encodeURIComponent(entityId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            am: amName,
            note,
            customer_id: customerId,
            bizname,
          }),
        },
      );
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Save failed");
      lastSavedRef.current = note;
      setUpdatedAt((data.updated_at as string) ?? null);
      setState("saved");
      // Phase 33.B.9 — fire deeper event for admin/usage funnels
      logEvent("note_saved", {
        surface: "v2_customer_detail",
        entity_id: entityId,
        // Phase 33.scope-slack — surface bizname + full note preview in Slack channel.
        metadata: { am: amName, bizname: bizname || null, note_length: note.length, note_preview: note },
      });
    } catch (e) {
      setState("error");
      setErrMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={handleSave}
        placeholder="What did you learn from the last call? Why is this customer at risk?"
        disabled={state === "loading"}
        rows={3}
        style={{
          width: "100%",
          minHeight: "72px",
          resize: "vertical",
          padding: "10px 12px",
          fontSize: "13px",
          lineHeight: 1.5,
          color: "var(--zoca-text)",
          background: state === "loading" ? "var(--zoca-bg-soft)" : "var(--zoca-bg)",
          border: "1px solid var(--zoca-border)",
          borderRadius: "10px",
          outline: "none",
          fontFamily: "inherit",
          transition: "border-color 0.18s ease, box-shadow 0.18s ease",
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "rgba(200, 67, 29, 0.38)";
          e.currentTarget.style.boxShadow = "0 0 0 3px rgba(200, 67, 29, 0.12)";
        }}
        onBlurCapture={(e) => {
          e.currentTarget.style.borderColor = "var(--zoca-border)";
          e.currentTarget.style.boxShadow = "none";
        }}
      />
      <div
        style={{
          marginTop: "6px",
          fontSize: "11px",
          color: "var(--zoca-text-2)",
          display: "flex",
          alignItems: "center",
          gap: "6px",
          minHeight: "16px",
        }}
      >
        {state === "loading" && <span>Loading…</span>}
        {state === "saving" && <span>Saving…</span>}
        {state === "saved" && (
          <span style={{ color: "#047857" }}>
            ✓ Saved {updatedAt ? `· ${relativeAge(updatedAt)}` : ""}
          </span>
        )}
        {state === "idle" && updatedAt && (
          <span>Last saved {relativeAge(updatedAt)}</span>
        )}
        {state === "error" && (
          <span style={{ color: "var(--zoca-pink)" }}>
            ⚠ {errMsg || "Save failed"}
          </span>
        )}
      </div>
    </div>
  );
}

export default NotesField;
