import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";

function authorized(request: NextRequest) {
  const expected = process.env.LIGHTNING_API_KEY;
  return Boolean(expected && request.headers.get("authorization") === `Bearer ${expected}`);
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await sql`UPDATE photo_worker_state SET status = 'idle', updated_at = NOW() WHERE id = 1`;
  return NextResponse.json({ ok: true });
}
