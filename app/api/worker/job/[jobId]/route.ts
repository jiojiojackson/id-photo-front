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
  const body = await request.json().catch(() => ({}));
  const status = body.status === "completed" ? "completed" : body.status === "failed" ? "failed" : null;
  if (!status) return NextResponse.json({ error: "status must be completed or failed" }, { status: 400 });

  await sql`
    UPDATE photo_jobs
    SET status = ${status},
        error = ${status === "failed" ? String(body.error || "Lightning processing failed") : null},
        processing_time_ms = ${Number.isFinite(body.processingTimeMs) ? Number(body.processingTimeMs) : null},
        completed_at = NOW()
    WHERE id = ${jobId}
  `;
  return NextResponse.json({ ok: true });
}
