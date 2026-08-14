import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { enqueueJob } from "@/lib/queue";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const lightningUrl = process.env.LIGHTNING_API_URL;
    if (!lightningUrl) {
      return NextResponse.json({ error: "LIGHTNING_API_URL 未配置" }, { status: 500 });
    }

    const claimed = await sql.begin(async (tx) => {
      const state = await tx`SELECT status FROM photo_worker_state WHERE id = 1 FOR UPDATE`;
      if (state[0]?.status !== "idle") {
        return { started: false, reason: "already_running" as const, jobs: 0 };
      }

      const jobs = await tx`
        SELECT id
        FROM photo_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
      `;
      if (!jobs.length) return { started: false, reason: "empty" as const, jobs: 0 };

      await tx`
        UPDATE photo_worker_state
        SET status = 'starting', started_at = NOW(), updated_at = NOW()
        WHERE id = 1
      `;
      return { started: true, reason: "started" as const, jobs: jobs.map((job) => String(job.id)) };
    });

    if (!claimed.started) {
      return NextResponse.json({ status: claimed.reason, queued: claimed.jobs }, { status: 200 });
    }

    for (const jobId of claimed.jobs) {
      await enqueueJob(jobId);
    }

    // Lightning's platform-managed endpoint handles its own authentication.
    // The application only needs the deployed endpoint URL and the worker path.
    const wakeResponse = await fetch(lightningUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bridgeUrl: new URL("/api/worker", request.url).origin }),
      cache: "no-store",
    });

    if (!wakeResponse.ok) {
      await sql`UPDATE photo_worker_state SET status = 'idle', updated_at = NOW() WHERE id = 1`;
      return NextResponse.json({ error: `启动 Lightning 失败 (${wakeResponse.status})` }, { status: 502 });
    }

    await sql`UPDATE photo_worker_state SET status = 'running', updated_at = NOW() WHERE id = 1`;
    return NextResponse.json({
      status: "started",
      jobs: claimed.jobs.length,
      estimatedSeconds: await estimateSeconds(claimed.jobs.length),
    });
  } catch (error) {
    console.error(error);
    await sql`UPDATE photo_worker_state SET status = 'idle', updated_at = NOW() WHERE id = 1`.catch(() => undefined);
    return NextResponse.json({ error: error instanceof Error ? error.message : "启动处理失败" }, { status: 500 });
  }
}

async function estimateSeconds(jobCount: number) {
  const rows = await sql`
    SELECT COALESCE(AVG(processing_time_ms), 0)::float8 AS avg_ms
    FROM photo_jobs
    WHERE status = 'completed' AND processing_time_ms IS NOT NULL
  `;
  const avgMs = Number(rows[0]?.avg_ms || 0);
  if (!avgMs) return null;
  return Math.max(1, Math.ceil((avgMs * jobCount) / 1000));
}
