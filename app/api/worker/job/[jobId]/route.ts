import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";

function authorized(request: NextRequest) {
  const expected = process.env.LIGHTNING_WORKER_TOKEN;
  return Boolean(expected && request.headers.get("authorization") === `Bearer ${expected}`);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { jobId } = await params;
  const rows = await sql`
    SELECT id, request_id, width, height, unit, dpi, background,
           input_key, output_key, input_url, output_url, url_expires_at, status
    FROM photo_jobs WHERE id = ${jobId}
  `;
  if (!rows.length) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return NextResponse.json({ job: rows[0] });
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
