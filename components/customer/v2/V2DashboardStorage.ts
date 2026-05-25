/**
 * V2Dashboard local-storage shims — Phase E-15.4d extraction.
 *
 * Pulled out of V2Dashboard.tsx so the file's component body stays focused
 * on snapshot state + render. The welcome-dismissed key has a 30-day TTL
 * (Phase E-7 P2) — the legacy "1" sentinel from before that change is
 * migrated to the {at} timestamp shape on read so existing dismissals
 * don't pop the strip back open on first read.
 */

export const STORAGE_AM_KEY = "zoca_v2_selected_am";
export const STORAGE_WELCOME_DISMISSED = "zoca_v2_welcome_dismissed";
export const WELCOME_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function readWelcomeDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(STORAGE_WELCOME_DISMISSED);
    if (!raw) return false;
    // Legacy value — treat as freshly dismissed and let it expire 30d from now.
    if (raw === "1") {
      window.localStorage.setItem(
        STORAGE_WELCOME_DISMISSED,
        JSON.stringify({ at: Date.now() }),
      );
      return true;
    }
    const parsed = JSON.parse(raw) as { at?: number } | null;
    if (!parsed || typeof parsed.at !== "number") return false;
    if (Date.now() - parsed.at > WELCOME_TTL_MS) {
      window.localStorage.removeItem(STORAGE_WELCOME_DISMISSED);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function writeWelcomeDismissed(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_WELCOME_DISMISSED,
      JSON.stringify({ at: Date.now() }),
    );
  } catch {
    /* ignore quota / private mode */
  }
}
