import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
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
