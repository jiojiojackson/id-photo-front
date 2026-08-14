import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";

function authorized(request: NextRequest) {
  const expected = process.env.LIGHTNING_API_KEY;
  return Boolean(expected && request.headers.get("authorization") === `Bearer ${expected}`);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { jobId } = await params;
  const result = await sql`
    UPDATE photo_jobs
    SET status = 'processing', started_at = COALESCE(started_at, NOW())
    WHERE id = ${jobId} AND status = 'queued'
    RETURNING id
  `;
  if (!result.length) return NextResponse.json({ ok: false, reason: "not_queued" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
