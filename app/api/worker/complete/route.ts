import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { authenticateWorker } from "@/lib/worker-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const worker = await authenticateWorker(request);
  if (!worker) return NextResponse.json({ error: "invalid or expired worker credential" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const jobId = String(body.jobId || "");
  if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });

  const processingTimeMs = Number.isFinite(body.processingTimeMs) ? Number(body.processingTimeMs) : null;
  const rows = await sql`
    UPDATE photo_jobs
    SET status = 'completed', completed_at = NOW(), error = NULL,
        processing_time_ms = ${processingTimeMs},
        input_url = NULL, output_url = NULL, url_expires_at = NULL
    WHERE id = ${jobId}
      AND status = 'processing'
      AND worker_run_id = ${String(worker.id)}
      AND lease_expires_at > NOW()
    RETURNING id
  `;

  if (!rows.length) {
    const existing = await sql`SELECT status, worker_run_id FROM photo_jobs WHERE id = ${jobId}`;
    if (existing[0]?.status === "completed") return NextResponse.json({ ok: true, idempotent: true });
    return NextResponse.json({ error: "job is not owned by this active worker lease" }, { status: 409 });
  }

  return NextResponse.json({ ok: true });
}
