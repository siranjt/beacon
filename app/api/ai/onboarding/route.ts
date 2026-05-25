/**
 * Beacon AI working-style onboarding — Phase E-12 (E-12.4).
 *
 * GET  /api/ai/onboarding → { completed: boolean }
 *   Checks whether the signed-in user has any fact with source='onboarding'.
 *   The AskPanel + settings page use this to decide whether to render the
 *   onboarding nudge / modal.
 *
 * POST /api/ai/onboarding → writes 4 style facts in one shot
 *   Body shape: { length, format, depth, tone } — each is a label string
 *   matching one of the canonical choices defined below.
 *
 * All four facts get:
 *   category   = style | depth | tone (depending on the question)
 *   source     = 'onboarding'
 *   confidence = 1.00
 *   scope_key  = NULL (global — they apply on every Beacon AI surface)
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  addExplicitFact,
  hasCompletedOnboarding,
  type FactCategory,
} from "@/lib/ai/facts";
import { logUmbrellaActivity } from "@/lib/activity/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Canonical answer labels. The Beacon AI prompt renders these verbatim, so
// keep them short, clear, and self-explanatory.
const ANSWERS = {
  length: {
    brief: "Prefers brief responses — 1-2 sentences when possible.",
    standard: "Prefers standard-length responses — 1-2 paragraphs.",
    detailed: "Prefers detailed responses — multi-section explanations.",
  },
  format: {
    bullets: "Prefers bullet lists over paragraphs.",
    prose: "Prefers prose paragraphs over bullet lists.",
    mixed: "Mixes bullets and prose based on content.",
  },
  depth: {
    answer_only: "Wants just the answer, no reasoning shown.",
    with_reasoning: "Wants the answer plus a one-line reason.",
    explore_options: "Wants 2-3 options laid out with trade-offs.",
  },
  tone: {
    terse: "Prefers terse, direct tone.",
    warm: "Prefers warm, encouraging tone.",
    formal: "Prefers formal, professional tone.",
  },
} as const;

// Map each question to its proper fact category — style for shape, depth
// for reasoning depth, tone for voice. (The format question is also `style`.)
const CATEGORY_FOR: Record<string, FactCategory> = {
  length: "style",
  format: "style",
  depth: "depth",
  tone: "tone",
};

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const completed = await hasCompletedOnboarding(session.user.email);
  return NextResponse.json({ ok: true, completed });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const email = session.user.email;
  const rawRole = (session.user as { role?: string }).role;
  const role: "admin" | "manager" | "am" | null =
    rawRole === "admin" || rawRole === "manager" || rawRole === "am" ? rawRole : null;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  // Validate each answer against the canonical set. Unknown keys are
  // silently ignored — we don't want a typo to fail the whole onboarding.
  const writes: Array<{ category: FactCategory; fact: string; key: string }> = [];
  for (const [key, choice] of Object.entries(body)) {
    if (typeof choice !== "string") continue;
    const allowed = (ANSWERS as Record<string, Record<string, string>>)[key];
    if (!allowed) continue;
    const text = allowed[choice];
    if (!text) continue;
    writes.push({
      key,
      category: CATEGORY_FOR[key] ?? "style",
      fact: text,
    });
  }

  if (writes.length === 0) {
    return NextResponse.json(
      { ok: false, error: "no_valid_answers" },
      { status: 400 },
    );
  }

  let saved = 0;
  for (const w of writes) {
    const result = await addExplicitFact({
      email,
      fact: w.fact,
      category: w.category,
      source: "onboarding",
      // scopeKey: null — onboarding answers are global by default.
    });
    if (result) saved++;
  }

  void logUmbrellaActivity({
    email,
    role,
    am_name: null,
    agent: "umbrella",
    event_name: "claude_onboarding_completed",
    surface: "launcher",
    entity_id: null,
    metadata: {
      kind: "ai_onboarding",
      answers_submitted: writes.length,
      facts_saved: saved,
    },
  });

  return NextResponse.json({ ok: true, saved });
}
