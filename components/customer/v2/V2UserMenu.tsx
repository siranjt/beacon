"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (1 hex/rgba + 0 tailwind-rose swept)

// Phase 33.A → 33.B → 33.D — Header user menu (avatar dropdown).
//
// Phase 33.D fixes:
//   1. Bumped z-index from 40 → 1000 so the popover sits above the
//      Refresh/Live/AM-Manager-view tab strip (which had a higher stack).
//   2. Dropped the duplicate role badge from the popover header. The avatar
//      trigger already shows it — repeating it inside the menu was the
//      "ADMIN appears twice" UI bug.
//   3. Switched the Sign-out button to onMouseDown + signOut() so the click
//      isn't swallowed by the outside-click handler (which also runs on
//      mousedown), then explicitly stopPropagation() so the menu doesn't
//      close before signOut() fires.
//   4. AM-book pill kept (it's not a duplicate of any other chip).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { signOut, useSession } from "next-auth/react";
import type { UserRole } from "@/lib/customer/config";

function initialsFor(name: string | null | undefined): string {
  if (!name) return "ZU";
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function badgeForRole(role: UserRole | null | undefined): {
  label: string;
  bg: string;
  fg: string;
} {
  if (role === "admin") {
    return {
      label: "ADMIN",
      bg: "rgba(255, 79, 168, 0.18)",
      fg: "#7C2D12",
    };
  }
  if (role === "manager") {
    return {
      label: "MANAGER",
      bg: "rgba(59, 130, 246, 0.18)",
      fg: "#1d4ed8",
    };
  }
  return {
    label: "AM",
    bg: "var(--zoca-bg-tint, rgba(11, 5, 29, 0.06))",
    fg: "var(--zoca-text-2, #4b5563)",
  };
}

export function V2UserMenu() {
  const { data: session, status } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  // Phase 33.scope-userMenuPortal — portal escapes V2Header stacking context.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; right: number }>({ top: 0, right: 0 });

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      // Phase 33.scope-userMenuPortal — popover is portaled to body so we need
      // to check both the trigger wrapper AND the portaled popover.
      if (ref.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Phase 33.scope-userMenuPortal — keep portaled popover anchored to the
  // avatar button on scroll / resize / orientation change.
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      setCoords({ top: Math.round(r.bottom + 8), right: Math.round(window.innerWidth - r.right) });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  if (status === "loading") {
    return (
      <div
        aria-hidden
        style={{
          width: "28px",
          height: "28px",
          borderRadius: "50%",
          background: "var(--zoca-bg-soft)",
          border: "1px solid var(--zoca-border)",
        }}
      />
    );
  }

  if (!session?.user) return null;

  const { name, email, image, role, am_name } = session.user;
  const displayName = name || email || "User";
  const badge = badgeForRole(role);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`User menu — signed in as ${displayName}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          padding: "4px 10px 4px 4px",
          borderRadius: "999px",
          border: "1px solid var(--zoca-border)",
          background: "var(--zoca-bg-soft)",
          cursor: "pointer",
          transition: "background 0.15s ease",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--zoca-bg-soft)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--zoca-bg-soft)";
        }}
      >
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt=""
            width={24}
            height={24}
            style={{
              width: "24px",
              height: "24px",
              borderRadius: "50%",
              objectFit: "cover",
              display: "block",
            }}
            referrerPolicy="no-referrer"
          />
        ) : (
          <span
            aria-hidden
            style={{
              width: "24px",
              height: "24px",
              borderRadius: "50%",
              background:
                "linear-gradient(135deg, var(--zoca-blue), var(--zoca-pink))",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "10px",
              fontWeight: 600,
              color: "white",
            }}
          >
            {initialsFor(displayName)}
          </span>
        )}
        <span
          style={{
            fontSize: "10.5px",
            fontWeight: 600,
            color: badge.fg,
            background: badge.bg,
            padding: "2px 7px",
            borderRadius: "999px",
            letterSpacing: "0.04em",
          }}
        >
          {badge.label}
        </span>
        <span style={{ fontSize: "10px", color: "var(--zoca-text-3)" }}>▾</span>
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={popoverRef}
          role="menu"
          aria-label="User menu"
          // Phase 33.scope-userMenuPortal — portaled to document.body with
          // position: fixed so we escape V2Header's backdrop-filter stacking
          // context (which had been trapping the dropdown beneath ScopeStrip
          // on Manager view and beneath V2AMTriage's sticky bar on AM view).
          style={{
            position: "fixed",
            top: coords.top,
            right: coords.right,
            zIndex: 9999,
            width: "260px",
            background: "var(--zoca-bg-soft)",
            border: "1px solid var(--zoca-border)",
            borderRadius: "12px",
            boxShadow: "0 12px 32px rgba(11,5,29,0.12)",
            overflow: "hidden",
            pointerEvents: "auto",
          }}
          // Stop bubble-up clicks from re-toggling the menu open state.
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{
              padding: "14px 14px 12px",
              borderBottom: "1px solid var(--zoca-border)",
            }}
          >
            <div
              style={{
                fontSize: "13px",
                fontWeight: 600,
                color: "var(--zoca-text)",
                lineHeight: 1.3,
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {displayName}
            </div>
            <div
              style={{
                marginTop: "2px",
                fontSize: "11.5px",
                color: "var(--zoca-text-2)",
                wordBreak: "break-all",
                lineHeight: 1.35,
              }}
            >
              {email || ""}
            </div>
            {/*
              Phase 33.D — the role badge ALREADY shows in the avatar trigger
              above; removed from the popover header to fix the "ADMIN appears
              twice" UI bug. The AM-book pill stays because it doesn't show
              elsewhere.
            */}
            {am_name && (
              <div
                style={{
                  marginTop: "10px",
                  display: "flex",
                  gap: "6px",
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontSize: "10.5px",
                    fontWeight: 500,
                    color: "var(--zoca-text-2)",
                    background: "var(--zoca-bg-soft)",
                    padding: "2px 8px",
                    borderRadius: "999px",
                    border: "1px solid var(--zoca-border)",
                  }}
                >
                  {am_name}
                </span>
              </div>
            )}
          </div>

          {/*
            Phase 33.D — onMouseDown + stopPropagation so signOut() fires
            BEFORE the outside-click mousedown handler runs. Previously the
            outside-click handler could close the popover and prevent the
            click from reaching the button, making sign-out feel "dead".
          */}
          <button
            type="button"
            role="menuitem"
            onMouseDown={(e) => {
              e.stopPropagation();
              void signOut({ callbackUrl: "/auth/signin" });
            }}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "11px 14px",
              border: "none",
              background: "transparent",
              color: "var(--zoca-text)",
              fontSize: "12.5px",
              cursor: "pointer",
              transition: "background 0.12s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--zoca-bg-soft)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            Sign out
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

export default V2UserMenu;
