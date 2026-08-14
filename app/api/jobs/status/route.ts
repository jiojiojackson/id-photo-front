import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { createPresignedUrl } from "@/lib/r2";

export const runtime = "nodejs";

export async function GET() {
  try {
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
