// Phase 33.B — API-route auth helpers.
//
// Three building blocks:
//   1. getApiUser()        → resolves the server session into a typed ApiUser
//                            object, or null if unauthenticated.
//   2. requireRole(...)    → returns null if the user holds an allowed role,
//                            otherwise a NextResponse(401|403) the route can
//                            return immediately.
//   3. requireAmScope()    → enforces per-AM scope on a request. Admins +
//                            managers bypass. role=am must match the
//                            customer's am_name against their session.
//
// Phase 33.B (usage tracking) — requireRole() fires a logActivity() row on
// every authorized request. Fire-and-forget; never blocks the route.
//
// Phase 33.B.6 (path capture) — the path from middleware's injected
// `x-request-path` header is included in metadata so we can answer
// "which endpoint is hot". Falls back to null if the header is missing
// (which happens for /api/health, /api/cron, /api/auth/* — those bypass
// middleware on purpose).
//
// Pattern for routes:
//
//   import { getApiUser, requireRole, requireAmScope } from "@/lib/customer/api-auth";
//
//   export async function POST(req: Request) {
//     const user = await getApiUser();
//     const denied = requireRole(user, "admin", "manager", "am");
//     if (denied) return denied;
//
//     // ...for scoped routes, look up the customer's am_name first:
//     const denied2 = requireAmScope(user, customer.am_name);
//     if (denied2) return denied2;
//
//     // ...existing handler logic
//   }
//
// All helpers are pure / synchronous EXCEPT getApiUser which awaits
// getServerSession. None of them throw — they return NextResponse on denial
// so callers can `return denied` and keep their handler shape flat.

import { getServerSession } from "next-auth";
import { authOptions } from "./auth-options";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import type { UserRole } from "./config";
import { logActivity } from "./activity";

export type ApiUser = {
  email: string;
  role: UserRole;
  am_name: string | null;
};

/**
 * Server-side session resolver for API routes. Returns the authenticated user
 * or null. Use in conjunction with requireRole() / requireAmScope() below.
 */
export async function getApiUser(): Promise<ApiUser | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return null;
  return {
    email: session.user.email,
    role: session.user.role,
    am_name: session.user.am_name,
  };
}

/**
 * Read the request path injected by middleware.ts. Returns null if the header
 * isn't available — either because middleware didn't run on this route (e.g.
 * /api/health, /api/cron) or because we're in a non-request context (tests).
 */
function getRequestPath(): string | null {
  try {
    return headers().get("x-request-path");
  } catch {
    // headers() throws outside a request scope — safe fallback.
    return null;
  }
}

/**
 * Reject the request if the user's role isn't in the allowed list.
 * Returns a NextResponse with 401/403, or null if access is allowed.
 *
 * Phase 33.B (usage tracking): fire-and-forget activity log row on success.
 * Phase 33.B.6 (path capture): metadata.path captures the endpoint URL.
 */
export function requireRole(
  user: ApiUser | null,
  ...allowed: UserRole[]
): NextResponse | null {
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  if (!allowed.includes(user.role)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Forbidden: requires ${allowed.join(" or ")} role`,
      },
      { status: 403 },
    );
  }

  // Phase 33.B / 33.B.6 — log every authorized API call with the route path.
  // Fire-and-forget; never blocks.
  const path = getRequestPath();
  void logActivity({
    email: user.email,
    role: user.role,
    am_name: user.am_name,
    event_name: "api_call",
    metadata: path ? { path } : null,
  });

  return null;
}

/**
 * Enforce per-AM scope on a request. Admins + managers bypass. AMs must match
 * the customer's am_name (passed in) against their session's am_name.
 * Returns null if allowed, NextResponse(401|403) if denied.
 */
export function requireAmScope(
  user: ApiUser | null,
  customerAmName: string | null | undefined,
): NextResponse | null {
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  if (user.role === "admin" || user.role === "manager") return null;
  // user.role === "am"
  if (!user.am_name) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Your account isn't mapped to an AM in BaseSheet yet — contact your manager",
      },
      { status: 403 },
    );
  }
  if (!customerAmName || customerAmName !== user.am_name) {
    return NextResponse.json(
      { ok: false, error: "Forbidden: this customer is not in your book" },
      { status: 403 },
    );
  }
  return null;
}
