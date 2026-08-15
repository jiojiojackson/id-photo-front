import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { authenticateWorker } from "@/lib/worker-auth";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const worker = await authenticateWorker(request);
  if (!worker) return NextResponse.json({ error: "invalid or expired worker credential" }, { status: 401 });

  const { jobId } = await params;
  const body = await request.json().catch(() => ({}));
  const status = body.status === "completed" ? "completed" : body.status === "failed" ? "failed" : null;
  if (!status) return NextResponse.json({ error: "status must be completed or failed" }, { status: 400 });

  const rows = await sql`
    UPDATE photo_jobs
    SET status = ${status},
        error = ${status === "failed" ? String(body.error || "Lightning processing failed") : null},
        processing_time_ms = ${Number.isFinite(body.processingTimeMs) ? Number(body.processingTimeMs) : null},
        completed_at = NOW(), input_url = NULL, output_url = NULL, url_expires_at = NULL
    WHERE id = ${jobId}
      AND status = 'processing'
      AND worker_run_id = ${String(worker.id)}
      AND lease_expires_at > NOW()
    RETURNING id
  `;

  if (!rows.length) {
    const existing = await sql`SELECT status FROM photo_jobs WHERE id = ${jobId}`;
    if (existing[0]?.status === "completed" && status === "completed") {
      return NextResponse.json({ ok: true, idempotent: true });
    }
    return NextResponse.json({ error: "job is not owned by this active worker lease" }, { status: 409 });
  }

  return NextResponse.json({ ok: true });
}
