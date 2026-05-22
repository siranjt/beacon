"use client";

import { useEffect, useRef, useState } from "react";
import { useToast } from "./Toast";
import { useMagnetic } from "@/lib/customer/hooks/useMagnetic";

/**
 * Phase 18.C: per-AM saved filter/search/sort combinations.
 *
 * Renders saved-view pills after the default filter pills in V2AMTriage.
 * Each pill loads the saved (filter, search, sort) trio with one click;
 * hovering reveals an × button to delete (with confirm). A "+ Save current
 * view" outline button opens an inline name input — Enter saves, Escape
 * cancels. 409 conflicts surface as inline error text.
 */

export type SavedViewConfig = {
  filter?: string;
  search?: string;
  sort?: string;
};

type SavedView = {
  id: number;
  name: string;
  filter_config: SavedViewConfig;
};

type Props = {
  amName: string;
  currentFilter: string;
  currentSearch: string;
  currentSort: string;
  onLoadView: (config: SavedViewConfig) => void;
};

export function SavedViewsRow({
  amName,
  currentFilter,
  currentSearch,
  currentSort,
  onLoadView,
}: Props) {
    const { showToast } = useToast();
const [views, setViews] = useState<SavedView[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingState, setSavingState] = useState<
    "idle" | "naming" | "saving" | "error"
  >("idle");
  const [newViewName, setNewViewName] = useState("");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const saveBtnRef = useMagnetic<HTMLButtonElement>({ strength: 0.18, radius: 70 });

  useEffect(() => {
    if (!amName) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/v2/views?am=${encodeURIComponent(amName)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data.ok) setViews(data.views);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [amName]);

  useEffect(() => {
    if (savingState === "naming") inputRef.current?.focus();
  }, [savingState]);

  async function handleSave() {
    const trimmed = newViewName.trim();
    if (!trimmed) return;
    setSavingState("saving");
    setErrMsg(null);
    try {
      const res = await fetch(`/api/v2/views`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          am: amName,
          name: trimmed,
          filter_config: {
            filter: currentFilter,
            search: currentSearch,
            sort: currentSort,
          },
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSavingState("error");
        setErrMsg(data.error || "Save failed");
        return;
      }
      setViews((prev) => [...prev, data.view]);
      setNewViewName("");
      setSavingState("idle");
    } catch (e) {
      setSavingState("error");
      setErrMsg(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDelete(id: number) {
    const prev = views;
    setViews((vs) => vs.filter((v) => v.id !== id));
    try {
      const res = await fetch(
        `/api/v2/views/${id}?am=${encodeURIComponent(amName)}`,
        { method: "DELETE" },
      );
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Delete failed");
    } catch (e) {
      setViews(prev);
      showToast(
        `Delete failed: ${e instanceof Error ? e.message : String(e)}`,
        { type: "error" },
      );
    }
  }

  if (loading) return null;

  return (
    <>
      {views.map((view) => (
        <SavedViewPill
          key={view.id}
          view={view}
          onClick={() => onLoadView(view.filter_config)}
          onDelete={() => handleDelete(view.id)}
        />
      ))}
      {savingState === "naming" || savingState === "saving" ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "0 4px",
          }}
        >
          <input
            ref={inputRef}
            value={newViewName}
            onChange={(e) => setNewViewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
              if (e.key === "Escape") {
                setSavingState("idle");
                setNewViewName("");
                setErrMsg(null);
              }
            }}
            placeholder="Name this view"
            disabled={savingState === "saving"}
            style={{
              padding: "6px 12px",
              fontSize: "12px",
              borderRadius: "9999px",
              border: "1px solid var(--zoca-border)",
              background: "var(--zoca-bg-soft)",
              color: "var(--zoca-text)",
              outline: "none",
              minWidth: "150px",
              fontFamily: "inherit",
            }}
          />
          <button
            onClick={handleSave}
            className="zoca-btn"
            style={{ fontSize: "11px", padding: "6px 14px" }}
            disabled={savingState === "saving"}
          >
            {savingState === "saving" ? "Saving…" : "Save"}
          </button>
          <button
            onClick={() => {
              setSavingState("idle");
              setNewViewName("");
              setErrMsg(null);
            }}
            style={{
              background: "transparent",
              border: 0,
              color: "var(--zoca-text-2)",
              fontSize: "11px",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          ref={saveBtnRef}
          onClick={() => {
            setSavingState("naming");
            setErrMsg(null);
          }}
          className="zoca-btn-outline"
          style={{
            fontSize: "11px",
            padding: "6px 12px",
            borderRadius: "9999px",
          }}
        >
          + Save current view
        </button>
      )}
      {savingState === "error" && errMsg && (
        <span
          style={{
            fontSize: "11px",
            color: "var(--zoca-pink)",
            marginLeft: "8px",
          }}
        >
          ⚠ {errMsg}
        </span>
      )}
    </>
  );
}

function SavedViewPill({
  view,
  onClick,
  onDelete,
}: {
  view: SavedView;
  onClick: () => void;
  onDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "stretch",
        borderRadius: "9999px",
        border: "1px solid var(--zoca-border)",
        background: "var(--zoca-bg-soft)",
        overflow: "hidden",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        onClick={onClick}
        style={{
          background: "transparent",
          border: 0,
          padding: "6px 12px",
          fontSize: "11px",
          color: "var(--zoca-text)",
          cursor: "pointer",
          fontFamily: "inherit",
          fontWeight: 500,
        }}
        title={`Load view: ${view.name}`}
      >
        {view.name}
      </button>
      {hovered && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Delete view "${view.name}"?`)) onDelete();
          }}
          style={{
            background: "transparent",
            border: 0,
            borderLeft: "1px solid var(--zoca-border)",
            padding: "0 8px",
            fontSize: "12px",
            color: "var(--zoca-text-2)",
            cursor: "pointer",
          }}
          aria-label={`Delete view ${view.name}`}
          title="Delete view"
        >
          ×
        </button>
      )}
    </span>
  );
}
