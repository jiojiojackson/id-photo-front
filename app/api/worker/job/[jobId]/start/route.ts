import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
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
