import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { ping } from "@/lib/metabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Performance Beacon — Metabase health check.
 *
 * Runs SELECT 1 against Aurora via the Dataset API. Returns 401 if not
 * signed in (Beacon umbrella auth gate), 500 if METABASE_API_KEY isn't
 * configured or the API is unreachable.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await ping();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
