"use client";

import { useState } from "react";
import EscalationForm from "./EscalationForm";
import ResultPanel from "./ResultPanel";
import type { AgentResult } from "@/lib/escalation/types";

interface ApiResponse {
  ok: boolean;
  context?: any;
  result?: AgentResult;
  error?: string;
}

/**
 * Triage form + result panel. Submits to /escalation/api/escalation.
 * Wrapped by the server-rendered triage/page.tsx that handles auth.
 */
export default function TriageClient() {
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);

  async function handleSubmit(payload: {
    text: string;
    email: string;
    customerId: string;
    entityId: string;
    bizName: string;
    medium: string;
  }) {
    setLoading(true);
    setResponse(null);
    try {
      const res = await fetch("/escalation/api/escalation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: payload.text,
          customerHint: {
            email: payload.email || undefined,
            customerId: payload.customerId || undefined,
            entityId: payload.entityId || undefined,
            bizName: payload.bizName || undefined,
          },
          source: { medium: payload.medium || "form" },
        }),
      });
      const data = (await res.json()) as ApiResponse;
      setResponse(data);
    } catch (err: any) {
      setResponse({ ok: false, error: err?.message || "Network error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <EscalationForm onSubmit={handleSubmit} disabled={loading} />
      <ResultPanel loading={loading} response={response} />
    </div>
  );
}
