import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getBackendHealth } from "@/lib/backend";

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
    await tx`SELECT id FROM photo_worker_state WHERE id = 1 FOR UPDATE`;
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

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const integer = (value: string | null, fallback: number, max: number) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
    };
    const pageSize = integer(params.get("pageSize"), 8, 50);
    const requestedPage = integer(params.get("page"), 1, 1000000);
    const filter = ["queued", "processing", "completed", "failed"].includes(params.get("status") || "") ? params.get("status")! : "";
    await reconcileStaleWorker();

    const [counts, state, backend] = await Promise.all([
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
      getBackendHealth(),
    ]);

    const total = Number(counts[0][filter || "total"] || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    let page = Math.min(requestedPage, totalPages);
    // Open the right library page when following a link to an older result.
    const focusId = params.get("jobId");
    if (focusId && focusId.length <= 100) {
      const position = await sql`
        SELECT COUNT(*)::int AS position FROM photo_jobs
        WHERE (${filter}::text = '' OR status = ${filter})
          AND (created_at, id) >= (
            SELECT created_at, id FROM photo_jobs
            WHERE id = ${focusId} AND (${filter}::text = '' OR status = ${filter})
          )
      `;
      if (Number(position[0]?.position) > 0) page = Math.min(Math.ceil(Number(position[0].position) / pageSize), totalPages);
    }
    const jobs = await sql`
      SELECT id, request_id, width, height, unit, dpi, background, output_key,
             status, error, processing_time_ms, created_at, started_at, completed_at
      FROM photo_jobs
      WHERE (${filter}::text = '' OR status = ${filter})
      ORDER BY created_at DESC, id DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `;

    const resultJobs = jobs.map((job) => ({
      ...job,
      resultUrl: job.status === "completed" ? `/api/jobs/image?jobId=${encodeURIComponent(String(job.id))}` : null,
    }));

    return NextResponse.json({
      counts: counts[0],
      worker: state[0] || { status: "idle" },
      jobs: resultJobs,
      backend,
      pagination: { page, pageSize, total, totalPages },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "获取任务状态失败" }, { status: 500 });
  }
}
