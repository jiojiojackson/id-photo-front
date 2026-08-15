import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { authenticateWorker } from "@/lib/worker-auth";

export const runtime = "nodejs";

const MAX_ATTEMPTS = 5;

export async function POST(request: Request) {
  const worker = await authenticateWorker(request);
  if (!worker) return NextResponse.json({ error: "invalid or expired worker credential" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const jobId = String(body.jobId || "");
  if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  const errorMessage = String(body.error || "Lightning processing failed").slice(0, 2000);

  const rows = await sql`
    UPDATE photo_jobs
    SET status = CASE WHEN attempt_count >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
        error = ${errorMessage},
        completed_at = CASE WHEN attempt_count >= ${MAX_ATTEMPTS} THEN NOW() ELSE NULL END,
        worker_run_id = NULL, claimed_at = NULL, lease_expires_at = NULL,
        input_url = NULL, output_url = NULL, url_expires_at = NULL
    WHERE id = ${jobId}
      AND status = 'processing'
      AND worker_run_id = ${String(worker.id)}
    RETURNING id, status
  `;

  if (!rows.length) {
    const existing = await sql`SELECT status FROM photo_jobs WHERE id = ${jobId}`;
    if (existing[0]?.status === "failed") return NextResponse.json({ ok: true, idempotent: true });
    return NextResponse.json({ error: "job is not owned by this worker" }, { status: 409 });
  }

  return NextResponse.json({ ok: true, status: rows[0].status });
}
