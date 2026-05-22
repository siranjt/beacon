"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { POD_MAP } from "@/lib/customer/config";

type Props = {
  selectedAm: string;
  allAms: string[];
  onChange: (am: string) => void;
};

function initialsFor(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * Phase 17.B.1 + 17.C — Consolidated top nav.
 *
 * Self-contained AM picker pill. Click to open a scrollable dropdown
 * listing every active AM (with their pod label on the right). Selection
 * fires onChange. URL ?am= and localStorage persistence is handled by
 * the parent (V2Dashboard) — this component is presentational + dropdown.
 *
 * Phase 24.B hotfix: dropdown is rendered into document.body via
 * React portal, escaping any ancestor stacking context (e.g. animated
 * ancestors with `transform` from Phase 22 which create their own
 * stacking context and trap z-index). The dropdown is positioned with
 * `position: fixed` anchored to the pill button's bounding rect.
 */
export function AmPickerPill({ selectedAm, allAms, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pillRect, setPillRect] = useState<DOMRect | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  // Compute pill rect when opening.
  useEffect(() => {
    if (open && pillRef.current) {
      setPillRect(pillRef.current.getBoundingClientRect());
    }
  }, [open]);

  // Recompute rect on scroll/resize while open so the dropdown stays
  // anchored to the pill even if the user scrolls.
  useEffect(() => {
    if (!open) return;
    function updateRect() {
      if (pillRef.current) {
        setPillRect(pillRef.current.getBoundingClientRect());
      }
    }
    window.addEventListener("scroll", updateRect, { passive: true });
    window.addEventListener("resize", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect);
      window.removeEventListener("resize", updateRect);
    };
  }, [open]);

  // Escape closes the dropdown.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const pod = selectedAm ? POD_MAP[selectedAm] || "Floating" : "";
  const initials = selectedAm ? initialsFor(selectedAm) : "??";

  // Flat alphabetical (A→Z) list. Pod info is still shown on the
  // outer pill (POD_MAP lookup above) — the dropdown no longer groups
  // by pod, just renders one row per AM in alphabetical order.
  const filtered = allAms
    .filter((am) =>
      am.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .slice()
    .sort((a, b) => a.localeCompare(b));

  return (
    <div className="relative">
      <button
        ref={pillRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`AM picker — selected ${selectedAm || "none"}`}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border bg-zoca-bg-soft transition cursor-pointer"
        style={{
          borderColor: "var(--zoca-border)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--zoca-bg-soft)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--zoca-bg-soft)";
        }}
      >
        <span
          style={{
            width: "22px",
            height: "22px",
            borderRadius: "50%",
            background:
              "linear-gradient(135deg, var(--zoca-blue), var(--zoca-pink))",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "10px",
            fontWeight: 600,
            color: "white",
            letterSpacing: 0,
          }}
          aria-hidden
        >
          {initials}
        </span>
        <span className="text-[12px] text-zoca-text font-medium">
          {selectedAm || "Select AM"}
        </span>
        {pod && (
          <span className="text-[11px] text-zoca-text-2">· {pod}</span>
        )}
        <span className="text-[10px] text-zoca-text-3">▾</span>
      </button>

      {open && pillRect && typeof document !== "undefined" &&
        createPortal(
          <>
            {/* Click-outside backdrop — invisible, sits just below the
                dropdown. Click anywhere outside the panel to close. */}
            <div
              onClick={() => setOpen(false)}
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 9998,
                background: "transparent",
              }}
              aria-hidden
            />
            {/* Actual dropdown — fully opaque so the hero gradient text
                cannot bleed through. */}
            <div
              ref={dropdownRef}
              role="menu"
              aria-label="Choose an AM"
              style={{
                position: "fixed",
                top: pillRect.bottom + 8,
                left: pillRect.left,
                minWidth: Math.max(pillRect.width, 288),
                maxWidth: "320px",
                zIndex: 9999,
                background: "var(--zoca-bg-soft)",
                border: "1px solid var(--zoca-border)",
                borderRadius: "12px",
                boxShadow:
                  "0 16px 40px rgba(11, 5, 29, 0.12), 0 4px 12px rgba(11, 5, 29, 0.06)",
                overflow: "hidden",
                maxHeight: "400px",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                className="px-3 py-2 border-b"
                style={{
                  borderColor: "var(--zoca-border)",
                  background: "var(--zoca-bg-soft)",
                }}
              >
                <input
                  type="text"
                  autoFocus
                  placeholder="Search AMs…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full bg-transparent text-[12px] text-zoca-text placeholder:text-zoca-text-3 focus:outline-none"
                  aria-label="Search AMs"
                />
              </div>
              <div
                className="overflow-y-auto py-1"
                style={{
                  scrollbarWidth: "thin",
                  background: "var(--zoca-bg-soft)",
                  flex: 1,
                }}
              >
                {filtered.length === 0 && (
                  <div className="px-3 py-3 text-[12px] text-zoca-text-2">
                    No AMs match.
                  </div>
                )}
                {filtered.map((am) => {
                  const isSelected = am === selectedAm;
                  return (
                    <button
                      key={am}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isSelected}
                      onClick={() => {
                        onChange(am);
                        setOpen(false);
                        setQuery("");
                      }}
                      className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] transition"
                      style={{
                        background: isSelected
                          ? "var(--zoca-bg-tint)"
                          : "transparent",
                        color: "var(--zoca-text)",
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected)
                          e.currentTarget.style.background =
                            "var(--zoca-bg-soft)";
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected)
                          e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          style={{
                            width: "18px",
                            height: "18px",
                            borderRadius: "50%",
                            background:
                              "linear-gradient(135deg, var(--zoca-blue), var(--zoca-pink))",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "9px",
                            fontWeight: 600,
                            color: "white",
                          }}
                          aria-hidden
                        >
                          {initialsFor(am)}
                        </span>
                        <span className="truncate">{am}</span>
                      </span>
                      {isSelected && (
                        <span
                          className="text-[10px]"
                          style={{ color: "var(--zoca-pink)" }}
                        >
                          ✓
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

export default AmPickerPill;
