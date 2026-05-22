"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (0 hex/rgba + 5 tailwind-rose swept)

import { useEffect, useMemo, useState } from "react";

type Channel = "chat" | "email" | "phone" | "video" | "sms";
type Direction = "in" | "out";

type CommsEvent = {
  ts: number;
  channel: Channel;
  direction: Direction;
  body: string;
  sender: string;
  duration?: number;
};

type Props = {
  entityId: string;
};

const CHANNEL_META: Record<Channel, { label: string; icon: string; tone: string }> = {
  chat: { label: "Chat", icon: "💬", tone: "bg-sky-500/14 text-sky-700 border-sky-300/50" },
  email: { label: "Email", icon: "✉", tone: "bg-emerald-500/14 text-emerald-700 border-emerald-300/50" },
  phone: { label: "Phone", icon: "📞", tone: "bg-amber-500/14 text-amber-700 border-amber-300/50" },
  video: { label: "Video", icon: "📹", tone: "bg-violet-500/14 text-violet-700 border-violet-300/50" },
  sms: { label: "SMS", icon: "📱", tone: "bg-zoca-pink/14 text-zoca-pink-bright border-pink-300/50" },
};

const CHANNELS: Channel[] = ["chat", "email", "phone", "video", "sms"];

function relativeAge(ts: number): string {
  const ms = Date.now() - ts;
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function fullDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString();
}

function V2CommsThreadPanel({ entityId }: Props) {
  const [events, setEvents] = useState<CommsEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [channelFilter, setChannelFilter] =
    useState<"all" | Channel>("all");
  const [directionFilter, setDirectionFilter] =
    useState<"all" | Direction>("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v2/customer/${encodeURIComponent(entityId)}/comms?days=90`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (!data.ok) {
          setError(data.error || "Signal lost — couldn't load comms");
          setEvents([]);
          return;
        }
        setEvents(Array.isArray(data.events) ? (data.events as CommsEvent[]) : []);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entityId]);

  const counts = useMemo(() => {
    const c: Record<Channel | "all", number> = {
      all: events.length,
      chat: 0,
      email: 0,
      phone: 0,
      video: 0,
      sms: 0,
    };
    for (const ev of events) c[ev.channel]++;
    return c;
  }, [events]);

  const filtered = useMemo(() => {
    return events.filter((ev) => {
      if (channelFilter !== "all" && ev.channel !== channelFilter) return false;
      if (directionFilter !== "all" && ev.direction !== directionFilter) return false;
      return true;
    });
  }, [events, channelFilter, directionFilter]);

  return (
    <section
      className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-4 md:p-5"
      aria-label="Communications thread"
    >
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-zoca-text-2">
          Comms thread · 90 days
        </h3>
        {!loading && !error && (
          <span className="text-[11px] text-zoca-text-2 tabular-nums">
            {filtered.length} / {events.length}
          </span>
        )}
      </div>

      {loading && (
        <div
          className="rounded-zoca border border-dashed border-zoca-border bg-zoca-bg-tint/40 px-3 py-4"
          aria-busy="true"
          aria-live="polite"
        >
          <div className="text-[12px] font-semibold text-zoca-text">
            Loading comms (3-10s)…
          </div>
          <div className="mt-1 text-[11px] text-zoca-text-2">
            Fetching App chat, email, phone, video, SMS from Metabase…
          </div>
          <div className="mt-3 space-y-2">
            <div className="h-3 w-2/3 animate-pulse rounded-zoca-pill bg-zoca-bg-tint" />
            <div className="ml-auto h-3 w-1/2 animate-pulse rounded-zoca-pill bg-zoca-bg-tint" />
            <div className="h-3 w-3/4 animate-pulse rounded-zoca-pill bg-zoca-bg-tint" />
            <div className="ml-auto h-3 w-2/5 animate-pulse rounded-zoca-pill bg-zoca-bg-tint" />
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="rounded-zoca border border-zoca-pink/50 bg-zoca-pink-soft px-3 py-2 text-[12px] text-zoca-pink-bright">
          ⚠ {error}
        </div>
      )}

      {!loading && !error && events.length === 0 && (
        <div className="rounded-zoca border border-dashed border-zoca-border bg-zoca-bg-tint/40 px-3 py-3 text-[12px] text-zoca-text-2">
          No customer activity captured in Metabase for this entity in 90 days.
        </div>
      )}

      {!loading && !error && events.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <FilterChip
              active={channelFilter === "all"}
              onClick={() => setChannelFilter("all")}
              label={`All · ${counts.all}`}
              tone="bg-zoca-bg-tint text-zoca-text border-zoca-border"
            />
            {CHANNELS.map((ch) => {
              const meta = CHANNEL_META[ch];
              return (
                <FilterChip
                  key={ch}
                  active={channelFilter === ch}
                  onClick={() =>
                    setChannelFilter((cur) => (cur === ch ? "all" : ch))
                  }
                  label={`${meta.icon} ${meta.label} · ${counts[ch]}`}
                  tone={meta.tone}
                />
              );
            })}
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <DirChip
              active={directionFilter === "all"}
              onClick={() => setDirectionFilter("all")}
              label="All"
            />
            <DirChip
              active={directionFilter === "in"}
              onClick={() =>
                setDirectionFilter((cur) => (cur === "in" ? "all" : "in"))
              }
              label="Inbound"
            />
            <DirChip
              active={directionFilter === "out"}
              onClick={() =>
                setDirectionFilter((cur) => (cur === "out" ? "all" : "out"))
              }
              label="Outbound"
            />
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-zoca border border-dashed border-zoca-border bg-zoca-bg-tint/40 px-3 py-3 text-[12px] text-zoca-text-2">
              No {channelFilter === "all" ? "" : channelFilter}{" "}
              activity in the last 90 days.
            </div>
          ) : (
            <ul className="space-y-2">
              {filtered.map((ev, i) => {
                const isExpanded = expanded.has(i);
                return (
                  <li key={i} className="w-full">
                    {ev.channel === "video" ? (
                      <VideoRow ev={ev} />
                    ) : (
                      <Bubble
                        ev={ev}
                        expanded={isExpanded}
                        onToggle={() =>
                          setExpanded((cur) => {
                            const next = new Set(cur);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          })
                        }
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  tone: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-zoca-pill border px-2 py-0.5 text-[11px] font-medium transition ${
        active
          ? tone
          : "border-zoca-border bg-zoca-bg-soft text-zoca-text-2 hover:bg-zoca-bg-tint"
      }`}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

function DirChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-zoca-pill border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition ${
        active
          ? "border-zoca-pink-cta bg-zoca-pink-cta/12 text-zoca-pink-cta"
          : "border-zoca-border bg-zoca-bg-soft text-zoca-text-2 hover:bg-zoca-bg-tint"
      }`}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

function Bubble({
  ev,
  expanded,
  onToggle,
}: {
  ev: CommsEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = CHANNEL_META[ev.channel];
  const inbound = ev.direction === "in";
  const body = (ev.body || "").trim();
  const lines = body.split(/\r?\n/);
  const isLong = lines.length > 4 || body.length > 320;
  const visible = expanded || !isLong
    ? body
    : (() => {
        const truncated = lines.slice(0, 4).join("\n");
        return truncated.length > 320
          ? truncated.slice(0, 320) + "…"
          : truncated;
      })();

  return (
    <div className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[70%] rounded-zoca-lg border px-3 py-2 text-[12px] leading-relaxed shadow-[0_1px_2px_rgba(11,5,29,0.04)] ${meta.tone}`}
      >
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-[10px]">
          <span className="inline-flex items-center gap-1 font-semibold uppercase tracking-wider">
            <span aria-hidden>{meta.icon}</span>
            {meta.label}
            <span className="font-normal text-zoca-text-2">
              · {inbound ? "Inbound" : "Outbound"}
            </span>
          </span>
          <span
            className="text-zoca-text-2 tabular-nums"
            title={fullDate(ev.ts)}
          >
            {relativeAge(ev.ts)}
          </span>
        </div>
        {body ? (
          <>
            <p
              className="whitespace-pre-wrap break-words text-zoca-text"
              title={body.length > 320 ? body : undefined}
            >
              {visible}
            </p>
            {isLong && (
              <button
                type="button"
                onClick={onToggle}
                className="mt-1 text-[10px] font-medium uppercase tracking-wider text-zoca-text-2 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40"
                aria-expanded={expanded}
              >
                {expanded ? "Collapse" : "Expand"}
              </button>
            )}
          </>
        ) : (
          <p className="text-zoca-text-2 italic">(no body)</p>
        )}
        {ev.channel === "phone" && typeof ev.duration === "number" && (
          <div className="mt-1 text-[10px] text-zoca-text-2 tabular-nums">
            duration {ev.duration}s
          </div>
        )}
      </div>
    </div>
  );
}

function VideoRow({ ev }: { ev: CommsEvent }) {
  const minutes = typeof ev.duration === "number"
    ? Math.max(0, Math.round(ev.duration / 60))
    : null;
  return (
    <div className="flex justify-center">
      <div className="max-w-[70%] rounded-zoca-lg border border-violet-300/50 bg-violet-500/10 px-3 py-1.5 text-center text-[11px] text-violet-800">
        <span aria-hidden className="mr-1">📹</span>
        Video meeting{minutes !== null ? ` — ${minutes}min` : ""}
        <span
          className="ml-2 text-[10px] text-zoca-text-2 tabular-nums"
          title={fullDate(ev.ts)}
        >
          · {relativeAge(ev.ts)}
        </span>
        {ev.sender && (
          <div className="text-[10px] text-zoca-text-2">{ev.sender}</div>
        )}
      </div>
    </div>
  );
}

export default V2CommsThreadPanel;
