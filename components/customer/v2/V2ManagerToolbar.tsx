"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (4 hex/rgba + 0 tailwind-rose swept)

import { useEffect, useMemo, useRef, useState } from "react";

export type SavedView = {
  name: string;
  selectedPod: string;
  currentDate: string;
  compareDays: number;
};

type Props = {
  availableDates: string[];
  currentDate: string;
  onDateChange: (date: string) => void;

  compareDays: number;
  onCompareDaysChange: (days: number) => void;
  comparisonLoading?: boolean;

  savedViews: SavedView[];
  currentViewName: string | null;
  onApplyView: (view: SavedView) => void;
  onSaveView: (name: string, overwrite: boolean) => boolean;
  onRenameView: (oldName: string, newName: string) => boolean;
  onDeleteView: (name: string) => void;

  // Reference iso timestamp for computing relative dates
  refIso: string | null;
};

const COMPARE_OPTIONS = [
  { value: 0, label: "No compare" },
  { value: 1, label: "vs 1d ago" },
  { value: 7, label: "vs 7d ago" },
  { value: 14, label: "vs 14d ago" },
  { value: 30, label: "vs 30d ago" },
];

function diffDays(targetDate: string, refIso: string | null): number | null {
  if (!refIso) return null;
  const target = new Date(`${targetDate}T12:00:00Z`);
  const ref = new Date(refIso);
  ref.setUTCHours(12, 0, 0, 0);
  return Math.round((ref.getTime() - target.getTime()) / 86400000);
}

function formatDateLabel(date: string, refIso: string | null): string {
  if (date === "today") return "Today (latest)";
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  const days = diffDays(date, refIso);
  const formatted = d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  if (days === null) return formatted;
  if (days === 0) return `Today · ${formatted}`;
  if (days === 1) return `Yesterday · ${formatted}`;
  if (days > 0 && days < 7) return `${days} days ago · ${formatted}`;
  if (days > 0) return `${formatted} (${days}d ago)`;
  return formatted;
}

function nearestAvailable(target: string, available: string[]): string | null {
  if (!available.length) return null;
  const tTime = new Date(`${target}T12:00:00Z`).getTime();
  let best: string | null = null;
  let bestDiff = Infinity;
  for (const d of available) {
    const dt = new Date(`${d}T12:00:00Z`).getTime();
    const diff = Math.abs(dt - tTime);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = d;
    }
  }
  return best;
}

export default function V2ManagerToolbar({
  availableDates,
  currentDate,
  onDateChange,
  compareDays,
  onCompareDaysChange,
  comparisonLoading,
  savedViews,
  currentViewName,
  onApplyView,
  onSaveView,
  onRenameView,
  onDeleteView,
  refIso,
}: Props) {
  const [viewsOpen, setViewsOpen] = useState(false);
  const [saveMode, setSaveMode] = useState(false);
  const [saveValue, setSaveValue] = useState("");
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const viewsRef = useRef<HTMLDivElement | null>(null);
  const saveInputRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!viewsOpen) return;
    const handler = (e: MouseEvent) => {
      if (viewsRef.current && !viewsRef.current.contains(e.target as Node)) {
        setViewsOpen(false);
        setSaveMode(false);
        setRenamingName(null);
      }
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setViewsOpen(false);
        setSaveMode(false);
        setRenamingName(null);
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", escHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escHandler);
    };
  }, [viewsOpen]);

  useEffect(() => {
    if (saveMode) {
      setSaveValue(currentViewName || "");
      setSaveError(null);
      setTimeout(() => saveInputRef.current?.focus(), 0);
    }
  }, [saveMode, currentViewName]);

  useEffect(() => {
    if (renamingName) {
      setRenameValue(renamingName);
      setTimeout(() => renameInputRef.current?.focus(), 0);
    }
  }, [renamingName]);

  const handleSaveSubmit = () => {
    const name = saveValue.trim();
    if (!name) {
      setSaveError("Name required.");
      return;
    }
    const exists = savedViews.some((v) => v.name === name);
    if (exists && name !== currentViewName) {
      const confirmed = window.confirm(`Replace existing view "${name}"?`);
      if (!confirmed) return;
      onSaveView(name, true);
    } else {
      onSaveView(name, exists);
    }
    setSaveMode(false);
    setSaveValue("");
  };

  const handleRenameSubmit = () => {
    if (!renamingName) return;
    const newName = renameValue.trim();
    if (!newName || newName === renamingName) {
      setRenamingName(null);
      return;
    }
    const exists = savedViews.some((v) => v.name === newName);
    if (exists) {
      const confirmed = window.confirm(`Replace existing view "${newName}"?`);
      if (!confirmed) return;
    }
    onRenameView(renamingName, newName);
    setRenamingName(null);
  };

  // Quick-jump pill targets
  const quickJumpTargets = useMemo(() => {
    const targets: { label: string; date: string; disabled: boolean }[] = [
      { label: "Today", date: "today", disabled: false },
    ];
    if (refIso) {
      const ymdAt = (daysAgo: number) => {
        const d = new Date(refIso);
        d.setUTCDate(d.getUTCDate() - daysAgo);
        return d.toISOString().slice(0, 10);
      };
      for (const [label, days] of [
        ["Yesterday", 1],
        ["7d ago", 7],
        ["14d ago", 14],
      ] as const) {
        const target = ymdAt(days);
        targets.push({
          label,
          date: target,
          disabled: !availableDates.some((d) => d.slice(0, 10) === target),
        });
      }
    }
    return targets;
  }, [availableDates, refIso]);

  return (
    <div
      className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl px-4 py-2.5 print:hidden"
      style={{
        background: "var(--zoca-bg-soft)",
        border: "1px solid var(--zoca-border)",
        boxShadow: "0 1px 2px rgba(11,5,29,0.03)",
      }}
      role="toolbar"
      aria-label="Manager view controls"
    >
      {/* Date picker */}
      <div className="flex items-center gap-1.5">
        <label htmlFor="manager-date" className="zoca-micro-label">
          Snapshot
        </label>
        <select
          id="manager-date"
          value={currentDate}
          onChange={(e) => onDateChange(e.target.value)}
          className="rounded-full px-2.5 py-1 text-[12px] text-zoca-text focus:outline-none"
          style={{
            background: "var(--zoca-bg-soft)",
            border: "1px solid var(--zoca-border)",
          }}
          aria-label="Snapshot date"
        >
          <option value="today">Today (latest)</option>
          {availableDates.map((d) => (
            <option key={d} value={d}>
              {formatDateLabel(d, refIso)}
            </option>
          ))}
        </select>
      </div>

      {/* Quick-jump pills */}
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label="Quick date jumps"
      >
        {quickJumpTargets.map((t) => {
          const active = t.date === currentDate;
          return (
            <button
              key={t.label}
              onClick={() => !t.disabled && onDateChange(t.date)}
              disabled={t.disabled}
              aria-pressed={active}
              title={t.disabled ? `No snapshot available for ${t.label}` : `Jump to ${t.label}`}
              className="rounded-full px-3 py-1 text-[11px] transition focus:outline-none"
              style={
                active
                  ? {
                      background: "var(--zoca-text)",
                      color: "#ffffff",
                      border: "1px solid var(--zoca-text)",
                      fontWeight: 600,
                    }
                  : t.disabled
                    ? {
                        cursor: "not-allowed",
                        background: "var(--zoca-bg-soft)",
                        color: "var(--zoca-text-3)",
                        border: "1px solid var(--zoca-border)",
                      }
                    : {
                        background: "transparent",
                        color: "var(--zoca-text-2)",
                        border: "1px solid var(--zoca-border)",
                        fontWeight: 500,
                      }
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Compare */}
      <div className="flex items-center gap-1.5">
        <label htmlFor="manager-compare" className="zoca-micro-label">
          Compare
        </label>
        <select
          id="manager-compare"
          value={compareDays}
          onChange={(e) => onCompareDaysChange(Number(e.target.value))}
          className="rounded-full px-2.5 py-1 text-[12px] text-zoca-text focus:outline-none"
          style={{
            background: "var(--zoca-bg-soft)",
            border: "1px solid var(--zoca-border)",
          }}
          aria-label="Compare to N days ago"
        >
          {COMPARE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {comparisonLoading && (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-zoca-text-2"
            role="status"
            aria-live="polite"
          >
            <span
              className="zoca-pulse-dot-pink inline-block"
              style={{ width: "8px", height: "8px" }}
              aria-hidden
            />
            Loading…
          </span>
        )}
      </div>

      {/* Saved views */}
      <div className="relative ml-auto" ref={viewsRef}>
        <button
          onClick={() => setViewsOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={viewsOpen}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] transition focus:outline-none"
          style={{
            background: "var(--zoca-bg-soft)",
            border: "1px solid var(--zoca-border)",
            color: "var(--zoca-text-2)",
          }}
        >
          <span aria-hidden style={{ color: "var(--zoca-pink)" }}>★</span>
          {currentViewName ? (
            <span className="max-w-[140px] truncate" style={{ color: "var(--zoca-text)" }}>
              {currentViewName}
            </span>
          ) : (
            <span>Saved views</span>
          )}
          <span className="text-[9px] text-zoca-text-3" aria-hidden>
            ▾
          </span>
        </button>
        {viewsOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-40 mt-1.5 w-72 overflow-hidden rounded-2xl"
            style={{
              background: "var(--zoca-bg-soft)",
              border: "1px solid var(--zoca-border)",
              boxShadow: "0 12px 28px -8px rgba(11,5,29,0.10)",
            }}
          >
            <div className="px-3 py-2 zoca-micro-label">
              Saved views
            </div>
            {savedViews.length === 0 && (
              <div className="px-3 pb-2 text-[11px] text-zoca-text-2">
                No saved views yet. Click "Save current view" below.
              </div>
            )}
            <ul className="max-h-72 overflow-y-auto">
              {savedViews.map((v) => {
                const isCurrent = v.name === currentViewName;
                const isRenaming = renamingName === v.name;
                return (
                  <li
                    key={v.name}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-[12px]"
                    style={{
                      borderTop: "1px solid var(--zoca-border)",
                      background: isCurrent ? "rgba(124, 45, 18, 0.06)" : "transparent",
                    }}
                  >
                    {isRenaming ? (
                      <form
                        className="flex flex-1 items-center gap-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          handleRenameSubmit();
                        }}
                      >
                        <input
                          ref={renameInputRef}
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setRenamingName(null);
                          }}
                          className="flex-1 rounded px-2 py-0.5 text-[11px] text-zoca-text focus:outline-none"
                          style={{
                            background: "var(--zoca-bg-soft)",
                            border: "1px solid var(--zoca-border-2)",
                          }}
                          aria-label="New view name"
                        />
                        <button
                          type="submit"
                          className="text-[11px] font-semibold underline-offset-2 hover:underline focus:outline-none"
                          style={{ color: "var(--zoca-pink)" }}
                          aria-label="Save new name"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setRenamingName(null)}
                          className="text-[11px] text-zoca-text-2 underline-offset-2 hover:underline focus:outline-none"
                          aria-label="Cancel rename"
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <>
                        <button
                          onClick={() => {
                            onApplyView(v);
                            setViewsOpen(false);
                          }}
                          className="flex-1 text-left text-zoca-text underline-offset-2 hover:underline focus:outline-none"
                          aria-label={`Apply view ${v.name}`}
                        >
                          <span className="font-medium">{v.name}</span>
                          <span className="ml-1 text-[10px] text-zoca-text-2">
                            {v.selectedPod === "All" ? "All pods" : v.selectedPod}
                            {v.currentDate !== "today" ? ` · ${v.currentDate}` : ""}
                            {v.compareDays > 0 ? ` · vs ${v.compareDays}d` : ""}
                          </span>
                        </button>
                        <button
                          onClick={() => setRenamingName(v.name)}
                          className="text-[11px] text-zoca-text-2 underline-offset-2 hover:underline focus:outline-none"
                          aria-label={`Rename view ${v.name}`}
                          title="Rename"
                        >
                          ✎
                        </button>
                        <button
                          onClick={() => onDeleteView(v.name)}
                          className="text-[12px] text-zoca-text-2 underline-offset-2 hover:underline focus:outline-none"
                          style={{ color: "var(--zoca-text-2)" }}
                          aria-label={`Delete view ${v.name}`}
                          title={`Delete view ${v.name}`}
                        >
                          ×
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
            <div style={{ borderTop: "1px solid var(--zoca-border)" }}>
              {saveMode ? (
                <form
                  className="flex items-center gap-1 px-3 py-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSaveSubmit();
                  }}
                >
                  <input
                    ref={saveInputRef}
                    type="text"
                    value={saveValue}
                    onChange={(e) => {
                      setSaveValue(e.target.value);
                      setSaveError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setSaveMode(false);
                    }}
                    placeholder="View name"
                    className="flex-1 rounded px-2 py-1 text-[12px] text-zoca-text focus:outline-none"
                    style={{
                      background: "var(--zoca-bg-soft)",
                      border: "1px solid var(--zoca-border-2)",
                    }}
                    aria-label="New view name"
                    aria-invalid={!!saveError}
                  />
                  <button
                    type="submit"
                    className="rounded-full px-3 py-0.5 text-[11px] font-semibold transition focus:outline-none"
                    style={{
                      background: "rgba(124, 45, 18, 0.10)",
                      color: "var(--zoca-pink)",
                      border: "1px solid rgba(200, 67, 29, 0.22)",
                    }}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setSaveMode(false)}
                    className="text-[11px] text-zoca-text-2 hover:text-zoca-text focus:outline-none"
                    aria-label="Cancel save"
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <button
                  onClick={() => setSaveMode(true)}
                  className="w-full px-3 py-2 text-left text-[12px] font-semibold transition focus:outline-none"
                  style={{ color: "var(--zoca-pink)" }}
                  aria-label="Save current view"
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(124, 45, 18, 0.05)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  + Save current view
                </button>
              )}
              {saveError && (
                <div
                  className="px-3 pb-2 text-[11px]"
                  style={{ color: "var(--zoca-pink)" }}
                  role="alert"
                >
                  {saveError}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export { nearestAvailable };
