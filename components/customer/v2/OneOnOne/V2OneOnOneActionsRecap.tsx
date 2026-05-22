"use client";
import type { OneOnOnePrepData } from "@/lib/customer/one-on-one";

type Props = { actions: OneOnOnePrepData["actions_last_7d"] };

export default function V2OneOnOneActionsRecap({ actions }: Props) {
  let rateColor = "var(--zoca-text)";
  if (actions.action_rate_pct >= 70) rateColor = "#047857";
  else if (actions.action_rate_pct < 30) rateColor = "#e11d48";

  return (
    <section
      className="mb-4 rounded-zoca-lg bg-zoca-bg-soft p-4 md:p-5"
      style={{ border: "0.5px solid var(--zoca-border)" }}
    >
      <h2
        className="font-extrabold text-zoca-text"
        style={{ fontSize: "15px", letterSpacing: "-0.01em" }}
      >
        Actions — last 7 days
      </h2>
      <p className="mt-0.5 text-[11px] text-zoca-text-2">
        Logged via the customer card outcome buttons. Action rate = actions /
        RED customers.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-3">
        <Stat label="Total" value={actions.total} />
        <Stat label="Connected" value={actions.connected} color="#047857" />
        <Stat label="Voicemail" value={actions.voicemail} color="var(--zoca-blue)" />
        <Stat label="No reach" value={actions.no_reach} color="var(--zoca-text-2)" />
        <Stat label="Escalated" value={actions.escalated} color="#b45309" />
        <Stat
          label="Action rate"
          value={`${actions.action_rate_pct}%`}
          color={rateColor}
        />
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div>
      <div
        className="text-[10.5px] uppercase tracking-wider text-zoca-text-2"
        style={{ letterSpacing: "0.04em" }}
      >
        {label}
      </div>
      <div
        className="mt-0.5 tabular-nums font-extrabold"
        style={{ fontSize: "16px", color: color ?? "var(--zoca-text)" }}
      >
        {value}
      </div>
    </div>
  );
}
