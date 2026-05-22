import type { ScoredCustomerV2 } from "./types";

// ---------------------------------------------------------------------------
// Phase 22.B.1 — Signal taxonomy.
//
// Maps user-facing signal labels to backend `signals_v2.sig_*` fields with
// the thresholds that promote a sub-score into a "this signal is active for
// this customer" predicate. Single `customerHasSignal()` predicate keeps the
// definition in one place — filter UI in V2AMTriage and chip click handlers
// in V2CustomerCard both go through this.
// ---------------------------------------------------------------------------

export type SignalKey =
  | "client_silent"
  | "we_silent"
  | "resp_drop"
  | "vol_collapse"
  | "usage_low"
  | "billing"
  | "perf_flag";

export const SIGNAL_KEYS: SignalKey[] = [
  "client_silent",
  "we_silent",
  "resp_drop",
  "vol_collapse",
  "usage_low",
  "billing",
  "perf_flag",
];

export const SIGNAL_LABELS: Record<SignalKey, string> = {
  client_silent: "Client silent",
  we_silent: "We silent",
  resp_drop: "Resp drop",
  vol_collapse: "Vol collapse",
  usage_low: "Usage low",
  billing: "Billing",
  perf_flag: "Performance flag",
};

export function isSignalKey(v: string | null | undefined): v is SignalKey {
  if (!v) return false;
  return (SIGNAL_KEYS as string[]).includes(v);
}

export function customerHasSignal(
  c: ScoredCustomerV2,
  signal: SignalKey,
): boolean {
  const s = c.signals_v2;
  if (!s) return false;
  switch (signal) {
    case "client_silent":
      return (s.sig_client_silent ?? 0) >= 65;
    case "we_silent":
      return (s.sig_we_silent ?? 0) >= 65;
    case "resp_drop":
      return (s.sig_response_drop ?? 0) >= 65;
    case "vol_collapse":
      return (s.sig_volume_collapse ?? 0) >= 55;
    case "usage_low":
      return (s.sig_usage ?? 0) >= 55;
    case "billing":
      return (s.sig_billing ?? 0) >= 40;
    case "perf_flag":
      return Boolean(s.flag_performance);
  }
}
