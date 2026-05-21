"use client";

import { useState } from "react";

interface Props {
  disabled?: boolean;
  onSubmit: (payload: {
    text: string;
    email: string;
    customerId: string;
    entityId: string;
    bizName: string;
    medium: string;
  }) => void;
}

const MEDIUMS = ["slack", "email", "sms", "phone", "video", "app_chat", "form", "webhook"];

export default function EscalationForm({ onSubmit, disabled }: Props) {
  const [text, setText] = useState("");
  const [email, setEmail] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [entityId, setEntityId] = useState("");
  const [bizName, setBizName] = useState("");
  const [medium, setMedium] = useState("form");

  return (
    <form
      className="rounded-2xl border border-border bg-panel p-6"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ text, email, customerId, entityId, bizName, medium });
      }}
    >
      <h2 className="text-lg font-medium mb-4">New escalation</h2>

      <label className="block text-sm text-muted mb-2">Message text</label>
      <textarea
        className="w-full min-h-[180px] rounded-lg border border-border bg-panel2 px-3 py-2 outline-none focus:border-accent"
        placeholder="Paste the customer's message, the Slack thread, the email body…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        required
      />

      <div className="grid grid-cols-2 gap-3 mt-4">
        <div>
          <label className="block text-sm text-muted mb-1">Customer email (optional)</label>
          <input
            className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 outline-none focus:border-accent"
            placeholder="owner@bizname.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm text-muted mb-1">Business name (optional)</label>
          <input
            className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 outline-none focus:border-accent"
            placeholder="Lacquer Lounge"
            value={bizName}
            onChange={(e) => setBizName(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm text-muted mb-1">Chargebee customer ID</label>
          <input
            className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 outline-none focus:border-accent"
            placeholder="AbCdEf123"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm text-muted mb-1">Entity ID (UUID)</label>
          <input
            className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 outline-none focus:border-accent"
            placeholder="0000…"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
          />
        </div>
      </div>

      <div className="mt-4">
        <label className="block text-sm text-muted mb-1">Source / medium</label>
        <select
          className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 outline-none focus:border-accent"
          value={medium}
          onChange={(e) => setMedium(e.target.value)}
        >
          {MEDIUMS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <button
        type="submit"
        disabled={disabled}
        className="mt-6 w-full rounded-lg bg-accent text-white py-2.5 font-medium disabled:opacity-50"
      >
        {disabled ? "Triaging…" : "Triage escalation"}
      </button>
    </form>
  );
}
