"use client";

import { useEffect, useMemo, useState } from "react";
import CommsActivityChart from "./charts/CommsActivityChart";
import ChannelMixDonut from "./charts/ChannelMixDonut";
import TicketsClassificationDonut from "./charts/TicketsClassificationDonut";
import TicketsOverTimeChart from "./charts/TicketsOverTimeChart";
import ResponseHealthCard from "./charts/ResponseHealthCard";
import {
  CHANNEL_COLORS,
  CHANNEL_LABELS,
  CLASSIFICATION_COLORS,
  CLASSIFICATION_LABELS,
} from "./charts/colors";

// ─── Types ────────────────────────────────────────────────────────────────

type Channel = "app_chat" | "email" | "phone" | "video" | "sms";
type Sender = "client" | "team" | "unknown";

interface Comm {
  channel: Channel;
  createdAt: string;
  sender: Sender;
  senderLabel?: string;
  body: string;
  durationSec?: number;
}

interface CustomerCard {
  bizName: string;
  entityId: string;
  customerId: string;
  email: string;
  phone: string;
  amName: string;
  spName: string;
  aeName: string;
  status: string;
  churnDate: string;
  monthlyRevenue?: number;
}

interface ChannelStatus { fetched: number; aborted: boolean; error?: string; }

interface Ticket {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  classification: string;
  category: string;
  churnPotentialStatus: string;
  createdAt: string;
  startedAt: string;
  completedAt: string;
  cancelledAt: string;
  entityId: string;
  customerName: string;
  customerId: string;
  amName: string;
  aeName: string;
  creatorEmail: string;
  assigneeEmail: string;
}

interface ApiResponse {
  ok: boolean;
  query?: string;
  matches?: CustomerCard[];
  customer?: CustomerCard | null;
  comms?: Comm[];
  stats?: { total: number; byChannel: Record<string, number>; bySender: Record<string, number>; };
  perChannelStatus?: Partial<Record<Channel, ChannelStatus>>;
  tickets?: Ticket[];
  skippedComms?: boolean;
  lookupNotes?: string[];
  error?: string;
}

interface TriageResult {
  severity: "P0" | "P1" | "P2" | "P3";
  category: string;
  ownerSuggestion: { role: string; namedPerson?: string; rationale: string };
  summary: string;
  draftReply: { channel: string; subject?: string; body: string };
  autoResolvable: { eligible: boolean; confidence: number; reason: string };
  routing: { actions: any[] };
  signalsUsed: string[];
}

interface TriageState {
  status: "idle" | "loading" | "ready" | "skipped" | "error";
  sourceMessage: Comm | null;
  result: TriageResult | null;
  error?: string;
  reason?: string;
}

type CommsLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

type Tab = "triage" | "tickets" | "history";

// ─── Constants ────────────────────────────────────────────────────────────

const CHANNELS: Channel[] = ["app_chat", "email", "phone", "video", "sms"];

const SEVERITY: Record<string, { bar: string; chip: string }> = {
  P0: { bar: "#7C2D12", chip: "bg-errSoft text-err border-err/30" },
  P1: { bar: "#7C2D12", chip: "bg-errSoft text-err border-err/30" },
  P2: { bar: "#2A4D5C", chip: "bg-cobaltSoft text-cobalt border-cobalt/30" },
  P3: { bar: "#8B7A66", chip: "bg-panel2 text-muted2 border-border" },
};

const TIME_WINDOWS: { key: string; label: string; days: number }[] = [
  { key: "30", label: "30d", days: 30 },
  { key: "90", label: "90d", days: 90 },
  { key: "365", label: "1y", days: 365 },
  { key: "0", label: "All time", days: 0 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────

function relTime(iso: string): string {
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return "";
  const sec = Math.floor((Date.now() - d) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}

function dateBucket(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown";
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return "Today";
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (
    d.getFullYear() === y.getFullYear() &&
    d.getMonth() === y.getMonth() &&
    d.getDate() === y.getDate()
  )
    return "Yesterday";
  const sameYear = d.getFullYear() === today.getFullYear();
  return sameYear
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtDuration(sec?: number): string {
  if (!sec || sec < 0) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

// Animated counter — small client-side count-up for stat numbers.
function useCountUp(target: number, durationMs = 700): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(target)) { setV(0); return; }
    const start = performance.now();
    const initial = 0;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / durationMs);
      const ease = 1 - Math.pow(1 - p, 3);
      setV(Math.round(initial + (target - initial) * ease));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return v;
}

// ─── Component ────────────────────────────────────────────────────────────

export default function EscalationsBrowser() {
  const [query, setQuery] = useState("");
  const [sinceDays, setSinceDays] = useState("90");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [commsState, setCommsState] = useState<CommsLoadState>({ status: "idle" });
  const [triage, setTriage] = useState<TriageState>({ status: "idle", sourceMessage: null, result: null });
  const [retrying, setRetrying] = useState<Set<Channel>>(new Set());
  const [tab, setTab] = useState<Tab>("triage");

  const [chartChannelFilter, setChartChannelFilter] = useState<string | null>(null);
  const [chartClassFilter, setChartClassFilter] = useState<string | null>(null);

  const [senderFilter, setSenderFilter] = useState<Sender | "all">("client");
  const [textFilter, setTextFilter] = useState("");

  // Which timeline rows have been clicked open. Keyed by `${day}-${index}`.
  const [expandedComms, setExpandedComms] = useState<Set<string>>(new Set());
  function toggleCommExpand(key: string) {
    setExpandedComms((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // "/" shortcut focuses the search input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault();
        const el = document.getElementById("c360-search-input") as HTMLInputElement | null;
        el?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Auto-search when arriving from the queue with ?q=<entityId>.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    if (!q || query) return;
    setQuery(q);
    // Defer one tick so the input value updates first.
    setTimeout(() => {
      const form = document.getElementById("c360-search-form") as HTMLFormElement | null;
      form?.requestSubmit();
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setResponse(null);
    setCommsState({ status: "idle" });
    setTriage({ status: "idle", sourceMessage: null, result: null });
    setChartChannelFilter(null);
    setChartClassFilter(null);
    setTab("triage");

    let phase1: ApiResponse | null = null;
    try {
      const u = new URL("/escalation/api/escalations", window.location.origin);
      u.searchParams.set("q", query.trim());
      u.searchParams.set("sinceDays", sinceDays);
      u.searchParams.set("skipComms", "1");
      const res = await fetch(u.toString());
      const text = await res.text();
      try {
        phase1 = JSON.parse(text) as ApiResponse;
        setResponse(phase1);
      } catch {
        setResponse({ ok: false, error: "Phase 1 returned non-JSON. Retry — cache should be primed now." });
        setLoading(false);
        return;
      }
    } catch (err: any) {
      setResponse({ ok: false, error: err?.message || "Network error" });
      setLoading(false);
      return;
    }
    setLoading(false);

    if (!phase1?.ok || !phase1.customer) return;

    setCommsState({ status: "loading" });
    let phase2: ApiResponse | null = null;
    try {
      const u = new URL("/escalation/api/escalations", window.location.origin);
      u.searchParams.set("q", query.trim());
      u.searchParams.set("sinceDays", sinceDays);
      const res = await fetch(u.toString());
      const text = await res.text();
      try {
        phase2 = JSON.parse(text) as ApiResponse;
      } catch {
        setCommsState({ status: "error", message: "Comms server returned non-JSON. Retry — cache should be primed." });
        return;
      }
      if (!phase2.ok) {
        setCommsState({ status: "error", message: phase2.error || "Comms fetch failed" });
        return;
      }
      setResponse((prev) =>
        prev
          ? {
              ...prev,
              comms: phase2!.comms,
              stats: phase2!.stats,
              perChannelStatus: phase2!.perChannelStatus,
              skippedComms: false,
              lookupNotes: phase2!.lookupNotes?.length ? phase2!.lookupNotes : prev.lookupNotes,
            }
          : prev
      );
      setCommsState({ status: "ready" });
    } catch (err: any) {
      setCommsState({ status: "error", message: err?.message || "Network error" });
      return;
    }

    const comms = phase2?.comms || [];
    const latestClient = comms.find((m) => m.sender === "client");
    if (!latestClient) {
      setTriage({
        status: "skipped",
        sourceMessage: null,
        result: null,
        reason: "No client-initiated message in this time window — nothing to triage.",
      });
      return;
    }
    setTriage({ status: "loading", sourceMessage: latestClient, result: null });
    try {
      // Send the customer + comms we already have so the route can skip the
      // 5-CSV refetch in buildContext (the cause of the timeout).
      const recentComms = (phase2?.comms || []).slice(0, 50);
      const r = await fetch("/escalation/api/escalation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: latestClient.body || "(empty body)",
          source: { medium: latestClient.channel, receivedAt: latestClient.createdAt },
          customerHint: {
            entityId: phase1.customer.entityId,
            customerId: phase1.customer.customerId,
            email: phase1.customer.email,
            bizName: phase1.customer.bizName,
          },
          prefetched: {
            customer: {
              bizName: phase1.customer.bizName,
              entityId: phase1.customer.entityId,
              customerId: phase1.customer.customerId,
              email: phase1.customer.email,
              phone: phase1.customer.phone,
              amName: phase1.customer.amName,
              spName: phase1.customer.spName,
              aeName: phase1.customer.aeName,
              status: phase1.customer.status,
              monthlyRevenue: phase1.customer.monthlyRevenue,
            },
            comms: recentComms,
          },
        }),
      });
      const text = await r.text();
      let tdata: any;
      try {
        tdata = JSON.parse(text);
      } catch {
        // Vercel returned an HTML error page (function timeout / crash). Surface a
        // clearer message instead of "Unexpected token 'A', 'An error o...'".
        setTriage({
          status: "error",
          sourceMessage: latestClient,
          result: null,
          error: `Agent endpoint returned non-JSON (Vercel function error). HTTP ${r.status}. Most likely a function timeout — check ANTHROPIC_API_KEY in Vercel env vars and retry.`,
        });
        return;
      }
      if (tdata.ok && tdata.result) {
        setTriage({ status: "ready", sourceMessage: latestClient, result: tdata.result as TriageResult });
      } else {
        setTriage({ status: "error", sourceMessage: latestClient, result: null, error: tdata.error || "Agent did not return a result" });
      }
    } catch (err: any) {
      setTriage({ status: "error", sourceMessage: latestClient, result: null, error: err?.message || "Network error during triage" });
    }
  }

  async function retryChannel(ch: Channel) {
    if (!response?.customer || !response.query) return;
    setRetrying((prev) => new Set(prev).add(ch));
    try {
      const url = new URL("/escalation/api/escalations", window.location.origin);
      url.searchParams.set("q", response.customer.entityId || response.query);
      url.searchParams.set("sinceDays", sinceDays);
      url.searchParams.set("channel", ch);
      const res = await fetch(url.toString());
      const text = await res.text();
      let data: ApiResponse;
      try {
        data = JSON.parse(text);
      } catch {
        data = { ok: false, error: `${ch}: still timing out — give the cache a moment.` };
      }
      setResponse((prev) => {
        if (!prev) return prev;
        const others = (prev.comms || []).filter((m) => m.channel !== ch);
        const next = [...others, ...(data.comms || [])].sort((a, b) =>
          a.createdAt < b.createdAt ? 1 : -1
        );
        const byChannel: Record<string, number> = {};
        const bySender: Record<string, number> = {};
        for (const m of next) {
          byChannel[m.channel] = (byChannel[m.channel] || 0) + 1;
          bySender[m.sender] = (bySender[m.sender] || 0) + 1;
        }
        return {
          ...prev,
          comms: next,
          stats: { total: next.length, byChannel, bySender },
          perChannelStatus: {
            ...prev.perChannelStatus,
            [ch]: data.perChannelStatus?.[ch] || {
              fetched: data.comms?.length || 0,
              aborted: false,
              error: data.error,
            },
          },
        };
      });
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(ch);
        return next;
      });
    }
  }

  const filteredComms = useMemo(() => {
    if (!response?.comms) return [];
    const t = textFilter.trim().toLowerCase();
    const out = response.comms.filter((m) => {
      if (chartChannelFilter && m.channel !== chartChannelFilter) return false;
      if (senderFilter !== "all" && m.sender !== senderFilter) return false;
      if (t && !(m.body || "").toLowerCase().includes(t)) return false;
      return true;
    });
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }, [response, chartChannelFilter, senderFilter, textFilter]);

  const groupedComms = useMemo(() => {
    const groups = new Map<string, Comm[]>();
    for (const m of filteredComms) {
      const k = dateBucket(m.createdAt);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(m);
    }
    return Array.from(groups.entries());
  }, [filteredComms]);

  const filteredTickets = useMemo(() => {
    if (!response?.tickets) return [];
    if (!chartClassFilter) return response.tickets;
    return response.tickets.filter((t) => t.classification === chartClassFilter);
  }, [response, chartClassFilter]);

  const ticketCount = response?.tickets?.length ?? 0;
  const openTicketCount =
    response?.tickets?.filter((t) =>
      ["Todo", "In Progress", "In Review"].includes(t.state)
    ).length ?? 0;
  const last30Comms = useMemo(() => {
    if (!response?.comms) return 0;
    const cut = Date.now() - 30 * 86400000;
    return response.comms.filter((m) => Date.parse(m.createdAt) > cut).length;
  }, [response]);

  const sinceDaysNum = TIME_WINDOWS.find((w) => w.key === sinceDays)?.days ?? 90;

  const abortedChannels: Channel[] = response?.perChannelStatus
    ? (Object.entries(response.perChannelStatus) as [Channel, ChannelStatus][])
        .filter(([, s]) => s?.aborted)
        .map(([ch]) => ch)
    : [];

  const ticketsAnimated = useCountUp(ticketCount);
  const last30Animated = useCountUp(last30Comms);
  const autoConfPct = triage.result?.autoResolvable.confidence ?? 0;
  const autoAnimated = useCountUp(Math.round(autoConfPct * 100));

  return (
    <div className="space-y-8">
      {/* HERO */}
      <section className="text-center pt-2">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-cobalt/20 bg-cobaltSoft text-xs font-semibold uppercase tracking-wider text-cobalt">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-cobalt live-dot" />
          Customer Success · live from Chargebee + Metabase
        </div>
        <div className="mt-5 flex items-center justify-center gap-5">
          <span
            aria-hidden
            className="text-3xl select-none"
            style={{ color: "#2A4D5C", opacity: 0.6 }}
          >
            ✦
          </span>
          <h1 className="brand-gradient-text font-extrabold text-[64px] leading-[1.0] tracking-[-0.02em]">
            Customer 360 Agent
          </h1>
          <span
            aria-hidden
            className="text-3xl select-none"
            style={{ color: "#D9A441", opacity: 0.7 }}
          >
            ✦
          </span>
        </div>
        <p className="mt-5 max-w-[580px] mx-auto text-[15px] text-muted2 leading-[1.65]">
          One search returns triage of their latest message, all related Linear tickets, and the
          full 5-channel comms timeline.
        </p>
      </section>

      {/* SEARCH */}
      <form id="c360-search-form" onSubmit={lookup} className="flex justify-center">
        <div
          className="flex items-center gap-3 pl-6 pr-2 py-2 rounded-full border border-border2 bg-panel w-full max-w-[640px]"
          style={{ boxShadow: "0 1px 2px rgba(13, 17, 23, 0.04)" }}
        >
          <span className="text-[10px] uppercase tracking-wider font-bold text-muted">Search</span>
          <input
            id="c360-search-input"
            className="flex-1 bg-transparent outline-none text-[14px] placeholder:text-muted"
            placeholder="Business name, entity_id, email, or Chargebee customer id"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <select
            className="bg-transparent text-xs text-muted2 outline-none cursor-pointer"
            value={sinceDays}
            onChange={(e) => setSinceDays(e.target.value)}
          >
            {TIME_WINDOWS.map((t) => (
              <option key={t.key} value={t.key} className="bg-panel">{t.label}</option>
            ))}
          </select>
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="rounded-full bg-cobalt text-white font-semibold px-6 py-2.5 text-[13px] disabled:opacity-50 transition-all hover:-translate-y-0.5"
            style={{ boxShadow: "0 4px 14px -4px rgba(59,91,255,0.4)" }}
          >
            {loading ? "Looking up…" : "Generate →"}
          </button>
        </div>
      </form>
      <p className="text-center text-xs text-muted -mt-4">
        Press{" "}
        <kbd className="font-mono px-1.5 py-0.5 rounded border border-border bg-panel2 text-muted2 text-[10px]">/</kbd>{" "}
        to focus
      </p>

      {/* ERROR / NO MATCH */}
      {response && response.ok === false && (
        <div className="rounded-xl border border-err/30 bg-errSoft p-4 text-sm fade-in-up">
          <p className="text-err font-semibold">Lookup failed</p>
          <p className="text-muted2 mt-1">{response.error}</p>
        </div>
      )}
      {response && response.ok && !response.customer && (
        <div className="rounded-xl border border-warn/30 bg-warnSoft p-4 text-sm fade-in-up">
          <p className="text-warn font-semibold">No customer match for &quot;{response.query}&quot;</p>
          <p className="text-muted2 mt-1">Try a UUID, exact biz name, an email, or the Chargebee customer id.</p>
        </div>
      )}

      {response && response.ok && response.customer && (
        <>
          {/* CUSTOMER CARD */}
          <section
            className="rounded-2xl border border-border p-8 fade-in-up"
            style={{
              background: "linear-gradient(120deg, #F8EFD7 0%, #FCE4D6 100%)",
            }}
          >
            <div className="flex items-start justify-between gap-8">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wider font-bold text-cobalt mb-2">
                  ● Customer · live
                </div>
                <div className="text-[38px] font-extrabold tracking-[-0.025em] leading-[1.0] truncate">
                  {response.customer.bizName || "(no name)"}
                </div>
                <div className="text-[14px] text-muted2 mt-2.5 truncate">
                  {response.customer.email || "—"}
                  {response.customer.phone ? ` · ${response.customer.phone}` : ""}
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-1.5 mt-3.5 text-[13px] text-muted">
                  {response.customer.amName && (
                    <span>AM <span className="text-text font-medium">{response.customer.amName}</span></span>
                  )}
                  {response.customer.spName && (
                    <span>SP <span className="text-text font-medium">{response.customer.spName}</span></span>
                  )}
                  {response.customer.aeName && (
                    <span>AE <span className="text-text font-medium">{response.customer.aeName}</span></span>
                  )}
                </div>
                <div className="text-[10px] text-muted/80 mt-2 font-mono truncate">
                  {response.customer.entityId || "—"}
                </div>
              </div>
              <div className="text-right shrink-0 pl-8 border-l border-border">
                <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1.5">MRR</div>
                <div className="text-[38px] font-extrabold tracking-[-0.025em] leading-[1.0]">
                  {typeof response.customer.monthlyRevenue === "number"
                    ? `$${response.customer.monthlyRevenue.toFixed(0)}`
                    : "—"}
                </div>
                {response.customer.status && (
                  <div
                    className={`inline-flex items-center gap-1.5 mt-2.5 text-xs font-medium rounded-full border px-2.5 py-1 ${
                      response.customer.status === "ZOCA" || response.customer.status === "active"
                        ? "border-ok/30 bg-okSoft text-ok"
                        : response.customer.status === "CHURNED"
                          ? "border-err/30 bg-errSoft text-err"
                          : "border-border bg-panel2 text-muted2"
                    }`}
                  >
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-current" />
                    {response.customer.status}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* STAT TILES */}
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
            <StatTile
              label="Tickets"
              value={String(ticketsAnimated)}
              sub={ticketCount > 0 ? `${openTicketCount} open · ${ticketCount - openTicketCount} closed` : "—"}
              accent="#2A4D5C"
            />
            <StatTile
              label="Comms · 30d"
              value={String(last30Animated)}
              sub={
                response.stats
                  ? `${response.stats.bySender.client || 0} client · ${response.stats.bySender.team || 0} team`
                  : commsState.status === "loading"
                    ? "loading…"
                    : "—"
              }
              accent="#C8431D"
            />
            <StatTile
              label="Severity"
              value={triage.result?.severity || "—"}
              sub={
                triage.result?.category
                  ? triage.result.category.replace(/_/g, " ")
                  : triage.status === "loading"
                    ? "triaging…"
                    : "—"
              }
              accent={SEVERITY[triage.result?.severity || "P3"]?.bar || "#8B7A66"}
              valueCls={
                triage.result?.severity === "P0" || triage.result?.severity === "P1"
                  ? "text-err"
                  : triage.result?.severity === "P2"
                    ? "text-cobalt"
                    : "text-text"
              }
            />
            <StatTile
              label="Auto-resolve"
              value={triage.result ? `${autoAnimated}%` : "—"}
              sub={
                triage.result?.autoResolvable.eligible
                  ? "Eligible · auto-send OK"
                  : triage.result
                    ? "Below 85 · human review"
                    : "—"
              }
              accent="#8B7A66"
            />
          </section>

          {/* CHARTS */}
          <section className="grid grid-cols-1 lg:grid-cols-[1.7fr_1fr] gap-3.5">
            <div className="rounded-2xl border border-border bg-panel p-6 card-hover">
              <CommsActivityChart comms={(response.comms || []) as any} sinceDays={sinceDaysNum} />
            </div>
            <div className="rounded-2xl border border-border bg-panel p-6 card-hover">
              <ChannelMixDonut
                comms={(response.comms || []) as any}
                sinceDays={sinceDaysNum}
                selected={chartChannelFilter}
                onSelect={(ch) => {
                  setChartChannelFilter(ch);
                  if (ch) setTab("history");
                }}
              />
            </div>
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-3 gap-3.5">
            <div className="rounded-2xl border border-border bg-panel p-6 card-hover">
              <TicketsClassificationDonut
                tickets={(response.tickets || []) as any}
                selected={chartClassFilter}
                onSelect={(c) => {
                  setChartClassFilter(c);
                  if (c) setTab("tickets");
                }}
              />
            </div>
            <div className="rounded-2xl border border-border bg-panel p-6 card-hover">
              <TicketsOverTimeChart tickets={(response.tickets || []) as any} weeks={12} />
            </div>
            <div className="card-hover">
              <ResponseHealthCard
                comms={(response.comms || []) as any}
                autoResolveConfidence={triage.result?.autoResolvable.confidence ?? null}
              />
            </div>
          </section>

          {/* SECTION TABS */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex gap-1.5 p-1.5 rounded-full bg-panel3 w-fit">
              <TabBtn active={tab === "triage"} onClick={() => setTab("triage")}>
                Triage
                {triage.status === "ready" && triage.result && (
                  <CountChip className={SEVERITY[triage.result.severity]?.chip}>{triage.result.severity}</CountChip>
                )}
                {triage.status === "loading" && <span className="ml-1.5 text-[10px] text-muted">…</span>}
              </TabBtn>
              <TabBtn active={tab === "tickets"} onClick={() => setTab("tickets")}>
                Tickets
                {ticketCount > 0 && <CountChip>{String(ticketCount)}</CountChip>}
              </TabBtn>
              <TabBtn active={tab === "history"} onClick={() => setTab("history")}>
                History
                {response.stats?.total ? <CountChip>{String(response.stats.total)}</CountChip> : null}
              </TabBtn>
            </div>
            <span className="text-xs text-muted">Click any chart segment above to drill down</span>
          </div>

          {/* TRIAGE */}
          {tab === "triage" && (
            <section className="fade-in-up">
              {triage.status === "idle" && commsState.status === "loading" && (
                <div className="rounded-2xl border border-border bg-panel p-6 text-sm text-muted2">
                  Fetching comms history first (5 channels)…
                </div>
              )}
              {triage.status === "skipped" && (
                <div className="rounded-2xl border border-border bg-panel p-6 text-sm text-muted2">
                  {triage.reason}
                </div>
              )}
              {triage.status === "loading" && (
                <div className="rounded-2xl border border-border bg-panel p-6 text-sm text-muted2">
                  Running the agent on the latest client message
                  {triage.sourceMessage ? ` (${triage.sourceMessage.channel}, ${relTime(triage.sourceMessage.createdAt)} ago)…` : "…"}
                </div>
              )}
              {triage.status === "error" && (
                <div className="rounded-2xl border border-err/30 bg-errSoft p-5 text-sm">
                  <p className="text-err font-semibold">Triage failed</p>
                  <p className="text-muted2 mt-1 whitespace-pre-wrap">{triage.error}</p>
                </div>
              )}
              {triage.status === "ready" && triage.result && triage.sourceMessage && (
                <div
                  className="rounded-2xl border border-border bg-panel severity-bar pl-7 pr-8 py-7"
                  style={{ ["--bar" as any]: SEVERITY[triage.result.severity]?.bar || "#8B7A66" }}
                >
                  <div className="flex items-baseline justify-between gap-3 mb-4">
                    <div className="flex items-center gap-3">
                      <span className={`text-xs font-semibold rounded-full border px-3 py-1 ${SEVERITY[triage.result.severity]?.chip || ""}`}>
                        {triage.result.severity}
                      </span>
                      <span className="font-bold text-lg capitalize tracking-tight">
                        {triage.result.category.replace(/_/g, " ")}
                      </span>
                    </div>
                    <span className="text-xs text-muted">
                      {triage.sourceMessage.channel.replace("_", " ")} · {relTime(triage.sourceMessage.createdAt)} ago
                    </span>
                  </div>

                  <div className="rounded-xl border border-border bg-panel2 px-4 py-3 text-sm text-muted2 italic mb-5 leading-relaxed">
                    &quot;{triage.sourceMessage.body}&quot;
                  </div>

                  <div className="text-[14px] leading-[1.7] mb-5">
                    <span className="text-muted">Owner</span>{" "}
                    <strong className="font-semibold">
                      {triage.result.ownerSuggestion.namedPerson || triage.result.ownerSuggestion.role}
                    </strong>
                    {triage.result.ownerSuggestion.namedPerson && (
                      <span className="text-muted"> · {triage.result.ownerSuggestion.role}</span>
                    )}
                    <span className="text-muted2"> — {triage.result.ownerSuggestion.rationale}</span>
                  </div>

                  <p className="text-[14px] leading-[1.7] mb-5 whitespace-pre-wrap">{triage.result.summary}</p>

                  <div className="rounded-xl border border-border bg-panel2 mb-4 overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-2.5 border-b border-border text-xs">
                      <span className="text-muted">
                        Draft reply · {triage.result.draftReply.channel}
                        {triage.result.draftReply.subject ? ` · "${triage.result.draftReply.subject}"` : ""}
                      </span>
                      <button
                        type="button"
                        onClick={() => navigator.clipboard?.writeText(triage.result!.draftReply.body)}
                        className="text-cobalt hover:underline underline-offset-2 transition-colors"
                      >
                        Copy ↗
                      </button>
                    </div>
                    <pre className="px-4 py-3.5 text-[14px] leading-[1.7] whitespace-pre-wrap font-sans">
{triage.result.draftReply.body}
                    </pre>
                  </div>

                  <div className="flex flex-wrap gap-2 text-xs">
                    <span
                      className={`rounded-full border px-3 py-1 ${
                        triage.result.autoResolvable.eligible
                          ? "bg-okSoft text-ok border-ok/30"
                          : "bg-panel2 text-muted2 border-border"
                      }`}
                    >
                      Auto-resolve {triage.result.autoResolvable.eligible ? "eligible" : "not eligible"} · {(triage.result.autoResolvable.confidence * 100).toFixed(0)}%
                    </span>
                    {triage.result.routing.actions.map((a: any, i: number) => (
                      <span key={i} className="rounded-full border border-border bg-panel2 px-3 py-1 text-muted2">
                        {a.type === "slack_dm" && <>Slack DM <strong className="text-text">{a.to}</strong></>}
                        {a.type === "slack_channel" && <>Slack <strong className="text-text">#{a.channel}</strong></>}
                        {a.type === "linear_issue" && <>Linear · <strong className="text-text">{a.title}</strong></>}
                        {a.type === "email" && <>Email <strong className="text-text">{a.to}</strong></>}
                        {a.type === "noop" && <>{a.reason}</>}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* TICKETS */}
          {tab === "tickets" && (
            <section className="rounded-2xl border border-border bg-panel overflow-hidden fade-in-up">
              <div className="px-5 py-3 border-b border-border text-xs text-muted flex items-center justify-between">
                <span>
                  {filteredTickets.length} {filteredTickets.length === 1 ? "ticket" : "tickets"}
                  {chartClassFilter && (
                    <span className="ml-2">
                      · filtered to{" "}
                      <strong className="text-text">{CLASSIFICATION_LABELS[chartClassFilter] || chartClassFilter}</strong>
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-3">
                  {chartClassFilter && (
                    <button
                      type="button"
                      onClick={() => setChartClassFilter(null)}
                      className="text-cobalt hover:underline"
                    >
                      Clear filter ✕
                    </button>
                  )}
                  <span>Latest first</span>
                </div>
              </div>
              {filteredTickets.length === 0 && (
                <div className="px-5 py-8 text-sm text-muted2">
                  {ticketCount === 0 ? "No tickets found in the Metabase feed for this customer." : "No tickets match this filter."}
                </div>
              )}
              {filteredTickets.map((t) => {
                const classBar = CLASSIFICATION_COLORS[t.classification] || "#8B7A66";
                const classLabel = CLASSIFICATION_LABELS[t.classification] || t.classification;
                const stateCls =
                  t.state === "Done"
                    ? "text-ok"
                    : t.state === "In Progress" || t.state === "In Review"
                      ? "text-cobalt"
                      : t.state === "Canceled" || t.state === "Duplicate"
                        ? "text-err"
                        : "text-text";
                return (
                  <div
                    key={t.id}
                    className="severity-bar row-divider row-hover px-5 py-3.5"
                    style={{ ["--bar" as any]: classBar }}
                  >
                    <div className="flex items-center gap-2 text-xs flex-wrap">
                      <span className="font-mono text-muted">{t.identifier || "—"}</span>
                      <span
                        className="rounded-full border px-2 py-0.5 font-medium"
                        style={{ borderColor: classBar + "55", background: classBar + "10", color: classBar }}
                      >
                        {classLabel}
                      </span>
                      <span className={stateCls}>{t.state}</span>
                      {t.churnPotentialStatus && (
                        <span className="rounded-full border border-warn/30 bg-warnSoft text-warn px-2 py-0.5">
                          {t.churnPotentialStatus}
                        </span>
                      )}
                      <span className="ml-auto text-muted">{relTime(t.createdAt)} ago</span>
                    </div>
                    <a
                      href={t.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block mt-1.5 text-[14px] font-medium hover:underline underline-offset-4 truncate"
                    >
                      {t.title}
                    </a>
                    <div className="text-xs text-muted mt-1">
                      {t.amName && <>AM <span className="text-text font-medium">{t.amName}</span></>}
                      {t.assigneeEmail && (
                        <>
                          {t.amName ? " · " : ""}Assignee <span className="text-text font-medium">{t.assigneeEmail}</span>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          {/* HISTORY */}
          {tab === "history" && (
            <section className="space-y-4 fade-in-up">
              {commsState.status === "loading" && (
                <div className="rounded-2xl border border-border bg-panel p-5 text-sm text-muted2">
                  Fetching comms history (5 channels)…
                </div>
              )}
              {commsState.status === "error" && (
                <div className="rounded-2xl border border-warn/30 bg-warnSoft p-5">
                  <p className="text-warn font-semibold text-sm">Comms history unavailable</p>
                  <p className="text-muted2 text-sm mt-1">{commsState.message}</p>
                </div>
              )}

              {abortedChannels.length > 0 && (
                <div className="rounded-2xl border border-warn/30 bg-warnSoft p-4">
                  <p className="text-xs text-warn mb-2 font-semibold">
                    {abortedChannels.length} channel{abortedChannels.length === 1 ? "" : "s"} timed out
                  </p>
                  <div className="flex flex-wrap gap-2 text-xs">
                    {abortedChannels.map((ch) => {
                      const busy = retrying.has(ch);
                      return (
                        <button
                          key={ch}
                          type="button"
                          onClick={() => retryChannel(ch)}
                          disabled={busy}
                          className="rounded-full border px-3 py-1 disabled:opacity-50 transition-all hover:-translate-y-0.5"
                          style={{
                            borderColor: (CHANNEL_COLORS[ch] || "#8B7A66") + "55",
                            color: CHANNEL_COLORS[ch] || "#8B7A66",
                            background: (CHANNEL_COLORS[ch] || "#8B7A66") + "10",
                          }}
                        >
                          {busy ? `Loading ${CHANNEL_LABELS[ch]}…` : `Retry ${CHANNEL_LABELS[ch]}`}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="rounded-2xl border border-border bg-panel p-4">
                <div className="flex flex-wrap gap-2 items-center text-xs">
                  <span className="text-muted">Channel</span>
                  {CHANNELS.map((c) => {
                    const on = chartChannelFilter === null || chartChannelFilter === c;
                    const color = CHANNEL_COLORS[c];
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setChartChannelFilter(chartChannelFilter === c ? null : c)}
                        className="rounded-full border px-3 py-1 transition-colors"
                        style={{
                          borderColor: on ? color + "55" : "#D4C29B",
                          background: on ? color + "10" : "#EBE0C2",
                          color: on ? color : "#8B7A66",
                        }}
                      >
                        {CHANNEL_LABELS[c]}
                      </button>
                    );
                  })}
                  <span className="ml-3 text-muted">Sender</span>
                  {(["all", "client", "team"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setSenderFilter(s)}
                      className={`rounded-full border px-3 py-1 transition-colors ${
                        senderFilter === s ? "border-brand/40 bg-brandSoft text-brand" : "border-border text-muted2 bg-panel2"
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                  <input
                    className="ml-auto bg-panel2 border border-border rounded-lg px-3 py-1.5 outline-none focus:border-cobalt text-xs w-56"
                    placeholder="Search messages…"
                    value={textFilter}
                    onChange={(e) => setTextFilter(e.target.value)}
                  />
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-panel overflow-hidden">
                {filteredComms.length === 0 ? (
                  <div className="p-8 text-sm text-muted2">
                    {commsState.status === "ready" ? "No messages match these filters." : "Comms not loaded yet."}
                  </div>
                ) : (
                  groupedComms.map(([day, items]) => (
                    <div key={day}>
                      <div className="px-5 py-2 text-[10px] uppercase tracking-wider text-muted bg-panel2 border-y border-border font-bold">
                        {day}
                      </div>
                      {items.map((m, i) => {
                        const key = `${day}-${i}-${m.createdAt}`;
                        const expanded = expandedComms.has(key);
                        const long = (m.body || "").length > 280;
                        return (
                          <div
                            key={key}
                            className="severity-bar row-divider row-hover px-5 py-3 cursor-pointer transition-all"
                            style={{ ["--bar" as any]: CHANNEL_COLORS[m.channel] || "#8B7A66" }}
                            onClick={() => toggleCommExpand(key)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                toggleCommExpand(key);
                              }
                            }}
                          >
                            <div className="flex items-center gap-2 text-xs">
                              <span className="text-muted">{CHANNEL_LABELS[m.channel] || m.channel}</span>
                              <span className="text-muted">·</span>
                              <span
                                className={
                                  m.sender === "client"
                                    ? "text-brand font-medium"
                                    : m.sender === "team"
                                      ? "text-ok font-medium"
                                      : "text-muted"
                                }
                              >
                                {m.sender}
                              </span>
                              {m.senderLabel && (
                                <>
                                  <span className="text-muted">·</span>
                                  <span className="text-text font-medium">{m.senderLabel}</span>
                                </>
                              )}
                              {m.durationSec ? (
                                <span className="text-muted">· {fmtDuration(m.durationSec)}</span>
                              ) : null}
                              <span className="ml-auto text-muted" title={m.createdAt}>
                                {relTime(m.createdAt)} ago
                              </span>
                            </div>
                            <div className="relative mt-1">
                              <p
                                className={`text-[14px] whitespace-pre-wrap leading-relaxed ${
                                  expanded ? "" : "line-clamp-3"
                                }`}
                              >
                                {m.body || "(no body)"}
                              </p>
                              {long && !expanded && (
                                <div
                                  className="pointer-events-none absolute bottom-0 left-0 right-0 h-6"
                                  style={{
                                    background: "linear-gradient(to bottom, rgba(248,239,215,0), #F8EFD7)",
                                  }}
                                />
                              )}
                            </div>
                            {long && (
                              <div className="mt-1.5 flex items-center gap-3">
                                <span className="text-[11px] text-cobalt font-medium">
                                  {expanded ? "Show less ↑" : "Show full message ↓"}
                                </span>
                                {expanded && (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      navigator.clipboard?.writeText(m.body || "");
                                    }}
                                    className="text-[11px] text-muted hover:text-text"
                                  >
                                    Copy
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </section>
          )}
        </>
      )}

      {!response && !loading && (
        <div className="text-center text-xs text-muted pt-2">
          Substring matches work — &quot;lacquer&quot; finds &quot;Lacquer Lounge LLC&quot;.
        </div>
      )}
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  sub,
  accent,
  valueCls,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: string;
  valueCls?: string;
}) {
  return (
    <div className="rounded-2xl bg-panel border border-border p-5 card-hover relative overflow-hidden">
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted">
        ● {label}
      </div>
      <div
        className={`text-[34px] font-extrabold tracking-[-0.025em] mt-2 leading-[1.0] ${valueCls || ""}`}
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </div>
      <div className="text-[11px] text-muted2 mt-1">{sub}</div>
      <div
        className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
        style={{ background: accent, opacity: 0.6 }}
      />
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-5 py-2 text-[13px] rounded-full transition-all ${
        active
          ? "bg-text text-white font-semibold"
          : "text-muted2 hover:text-text hover:bg-panel"
      }`}
    >
      <span className="inline-flex items-center gap-2">{children}</span>
    </button>
  );
}

function CountChip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`text-[10px] font-semibold rounded-full px-2 py-0.5 ${className || "bg-cobaltSoft text-cobalt"}`}>
      {children}
    </span>
  );
}
