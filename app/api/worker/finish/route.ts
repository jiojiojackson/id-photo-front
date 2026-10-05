import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { authenticateWorker } from "@/lib/worker-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const worker = await authenticateWorker(request);
  if (!worker) return NextResponse.json({ error: "invalid or expired worker credential" }, { status: 401 });

  const runId = String(worker.id);
  const body = await request.json().catch(() => ({}));
  if (typeof body.error === "string" && body.error) {
    const error = body.error.slice(0, 2000);
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM photo_worker_state WHERE id = 1 FOR UPDATE`;
      await tx`
        UPDATE photo_jobs SET status = 'failed', error = ${error}, completed_at = NOW(),
          worker_run_id = NULL, claimed_at = NULL, lease_expires_at = NULL,
          input_url = NULL, output_url = NULL, url_expires_at = NULL
        WHERE worker_run_id = ${runId} AND status = 'processing'
      `;
      await tx`UPDATE photo_worker_runs SET status = 'failed', error = ${error}, finished_at = NOW(), last_seen_at = NOW() WHERE id = ${runId} AND status IN ('starting', 'running')`;
      await tx`UPDATE photo_worker_state SET status = 'idle', active_run_id = NULL, updated_at = NOW() WHERE id = 1 AND active_run_id = ${runId}`;
    });
    return NextResponse.json({ ok: true, status: "failed" });
  }
  const activeJobs = await sql`
    SELECT COUNT(*)::int AS count
    FROM photo_jobs
    WHERE worker_run_id = ${runId} AND status = 'processing' AND lease_expires_at > NOW()
  `;
  if (Number(activeJobs[0]?.count || 0) > 0) {
    return NextResponse.json({ error: "worker still owns processing jobs" }, { status: 409 });
  }

  await sql.begin(async (tx) => {
    // Start and cleanup also lock state before touching runs. Keep the same lock
    // order so finishing and starting a run cannot deadlock each other.
    await tx`SELECT id FROM photo_worker_state WHERE id = 1 FOR UPDATE`;
    await tx`
      UPDATE photo_worker_runs
      SET status = 'completed', finished_at = NOW(), last_seen_at = NOW()
      WHERE id = ${runId} AND status IN ('starting','running')
    `;
    await tx`
      UPDATE photo_worker_state
      SET status = 'idle', active_run_id = NULL, updated_at = NOW()
      WHERE id = 1 AND active_run_id = ${runId}
    `;
  });
  return NextResponse.json({ ok: true });
}
