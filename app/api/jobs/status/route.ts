import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { createPresignedUrl } from "@/lib/r2";

export const runtime = "nodejs";

const WORKER_STALE_SECONDS = 120;

/**
 * Turn a genuinely lost Worker Run into a terminal Job failure.
 *
 * This is deliberately executed when status is requested instead of using a
 * background polling loop. If Lightning/Studio dies, its last_seen_at stops
 * advancing; the next status request after the stale window makes the real
 * database state visible to the UI.
 */
async function reconcileStaleWorker() {
  await sql.begin(async (tx) => {
    const staleRuns = await tx`
      SELECT id
      FROM photo_worker_runs
      WHERE status IN ('starting', 'running')
        AND (
          credential_expires_at <= NOW()
          OR last_seen_at <= NOW() - (${WORKER_STALE_SECONDS} || ' seconds')::interval
        )
      FOR UPDATE
    `;

    for (const run of staleRuns) {
      const runId = String(run.id);
      const errorMessage = `Worker Run 已失联超过 ${WORKER_STALE_SECONDS} 秒，后端可能已停止。`;

      await tx`
        UPDATE photo_jobs
        SET status = 'failed',
            error = ${errorMessage},
            completed_at = NOW(),
            worker_run_id = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL,
            input_url = NULL,
            output_url = NULL,
            url_expires_at = NULL
        WHERE worker_run_id = ${runId}
          AND status = 'processing'
      `;

      await tx`
        UPDATE photo_worker_runs
        SET status = 'failed', finished_at = NOW(), error = ${errorMessage}
        WHERE id = ${runId}
          AND status IN ('starting', 'running')
      `;

      await tx`
        UPDATE photo_worker_state
        SET status = 'idle', active_run_id = NULL, updated_at = NOW()
        WHERE id = 1 AND active_run_id = ${runId}
      `;
    }
  });
}

export async function GET() {
  try {
    await reconcileStaleWorker();

    const [counts, state, jobs] = await Promise.all([
      sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
          COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
          COUNT(*)::int AS total
        FROM photo_jobs
      `,
      sql`SELECT status, started_at FROM photo_worker_state WHERE id = 1`,
      sql`
        SELECT id, request_id, width, height, unit, dpi, background, output_key,
               status, error, processing_time_ms, created_at, started_at, completed_at
        FROM photo_jobs
        ORDER BY created_at DESC
        LIMIT 30
      `,
    ]);

    const resultJobs = await Promise.all(jobs.map(async (job) => ({
      ...job,
      resultUrl: job.status === "completed" ? await createPresignedUrl("GET", job.output_key, 30 * 60) : null,
    })));

    return NextResponse.json({
      counts: counts[0],
      worker: state[0] || { status: "idle" },
      jobs: resultJobs,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "获取任务状态失败" }, { status: 500 });
  }
}
