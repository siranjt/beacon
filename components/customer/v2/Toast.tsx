"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (2 hex/rgba + 0 tailwind-rose swept)

import * as React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

// ---------------------------------------------------------------------------
// Phase 22.A — Toast notification system.
//
// Self-contained: <ToastProvider> at the V2 tree root, `useToast()` hook
// anywhere underneath. Renders a stack of light-card toasts at the bottom-
// right of the viewport (fixed positioning — no portal dependency, the
// stack lives in normal DOM order at the bottom of the provider).
//
// Replaces window.alert() across V2 components for non-blocking feedback.
// ---------------------------------------------------------------------------

export type ToastType = "success" | "info" | "warning" | "error";

export type ToastOptions = {
  type?: ToastType;
  duration?: number; // ms; default 3000
  icon?: string; // semantic key, ignored if no Tabler integration
};

type ToastItem = {
  id: number;
  message: string;
  type: ToastType;
  duration: number;
  icon?: string;
  // exit flag flips so the stack can animate the toast out before unmount
  exiting?: boolean;
};

type ToastContextValue = {
  showToast: (message: string, options?: ToastOptions) => number;
  dismissToast: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const DOT_COLOR: Record<ToastType, string> = {
  success: "#10b981",
  info: "#0ea5e9",
  warning: "#f59e0b",
  error: "#C8431D",
};

const EXIT_MS = 220;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)),
    );
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, EXIT_MS);
  }, []);

  const showToast = useCallback(
    (message: string, options: ToastOptions = {}) => {
      const id = Date.now() + Math.floor(Math.random() * 1000);
      const next: ToastItem = {
        id,
        message,
        type: options.type || "info",
        duration: options.duration ?? 3000,
        icon: options.icon,
      };
      setToasts((prev) => [...prev, next]);
      if (next.duration > 0) {
        window.setTimeout(() => dismissToast(id), next.duration);
      }
      return id;
    },
    [dismissToast],
  );

  const value = useMemo<ToastContextValue>(
    () => ({ showToast, dismissToast }),
    [showToast, dismissToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Soft fallback so a render outside the provider doesn't crash — it
    // just becomes a no-op (with a console hint in dev).
    if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("useToast() called outside <ToastProvider>");
    }
    return { showToast: () => 0, dismissToast: () => {} };
  }
  return ctx;
}

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      style={{
        position: "fixed",
        right: 20,
        bottom: 20,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: () => void;
}) {
  const [hover, setHover] = useState(false);
  const dot = DOT_COLOR[toast.type];
  return (
    <div
      role="status"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        pointerEvents: "auto",
        minWidth: 260,
        maxWidth: 360,
        background: "var(--zoca-bg-soft)",
        border: "1px solid var(--zoca-border, rgba(11,5,29,0.08))",
        borderRadius: 12,
        boxShadow: toast.exiting
          ? "0 4px 12px rgba(11,5,29,0.06)"
          : "0 6px 24px rgba(11,5,29,0.10), 0 0 18px rgba(252, 228, 214, 0.18)",
        padding: "12px 14px",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        animation: toast.exiting
          ? "v2-toast-out 0.22s cubic-bezier(0.4,0,1,1) forwards"
          : "v2-toast-in 0.32s cubic-bezier(0.34,1.56,0.64,1) forwards",
      }}
    >
      <span
        aria-hidden
        style={{
          flex: "none",
          marginTop: 5,
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dot,
          boxShadow: `0 0 6px ${dot}66`,
        }}
      />
      <div
        style={{
          flex: 1,
          fontSize: 13,
          lineHeight: 1.45,
          color: "var(--zoca-text, #0b051d)",
        }}
      >
        {toast.icon && (
          <span
            aria-hidden
            style={{ marginRight: 6, opacity: 0.7, fontSize: 12 }}
          >
            {iconGlyph(toast.icon)}
          </span>
        )}
        {toast.message}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="no-press"
        style={{
          flex: "none",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: 0,
          marginLeft: 2,
          width: 18,
          height: 18,
          borderRadius: "50%",
          color: "var(--zoca-text-2, #4b4660)",
          opacity: hover ? 0.85 : 0.45,
          fontSize: 14,
          lineHeight: "18px",
          transition: "opacity 0.12s ease",
        }}
      >
        ×
      </button>
    </div>
  );
}

// Very small icon -> glyph map. Keeps the API stable even if we wire
// Tabler later. Anything not in the map renders the literal key.
function iconGlyph(key: string): string {
  switch (key) {
    case "pin":
      return "📌";
    case "snooze":
      return "💤";
    case "check":
      return "✓";
    case "warn":
      return "⚠";
    case "error":
      return "⚠";
    case "refresh":
      return "↻";
    default:
      return "";
  }
}
