import { NextResponse } from "next/server";
import { receive, PHOTO_QUEUE_CONSUMER, PHOTO_QUEUE_NAME } from "@/lib/queue";
import { sql } from "@/lib/db";
import { createPresignedUrl } from "@/lib/r2";
import { authenticateWorker } from "@/lib/worker-auth";

export const runtime = "nodejs";

// Initial safety margin. Measure the real Lightning p95/max inference time and
// tune this before production. Heartbeat extends the lease during long jobs.
const LEASE_SECONDS = 10 * 60;
const MAX_ATTEMPTS = 5;

async function claim(jobId: string, workerRunId: string) {
  const rows = await sql.begin(async (tx) => tx`
    WITH candidate AS (
      SELECT id
      FROM photo_jobs
      WHERE id = ${jobId}
        AND attempt_count < ${MAX_ATTEMPTS}
        AND (status = 'queued' OR (status = 'processing' AND lease_expires_at <= NOW()))
      FOR UPDATE SKIP LOCKED
    )
    UPDATE photo_jobs AS j
    SET status = 'processing', worker_run_id = ${workerRunId}, claimed_at = NOW(),
        lease_expires_at = NOW() + (${LEASE_SECONDS} || ' seconds')::interval,
        attempt_count = j.attempt_count + 1,
        started_at = COALESCE(j.started_at, NOW()), error = NULL
    FROM candidate
    WHERE j.id = candidate.id
    RETURNING j.id, j.request_id, j.width, j.height, j.unit, j.dpi, j.background,
              j.input_key, j.output_key, j.attempt_count, j.lease_expires_at
  `);
  return rows[0] || null;
}

async function claimNext(workerRunId: string) {
  const rows = await sql.begin(async (tx) => tx`
    WITH candidate AS (
      SELECT id
      FROM photo_jobs
      WHERE attempt_count < ${MAX_ATTEMPTS}
        AND (status = 'queued' OR (status = 'processing' AND lease_expires_at <= NOW()))
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE photo_jobs AS j
    SET status = 'processing', worker_run_id = ${workerRunId}, claimed_at = NOW(),
        lease_expires_at = NOW() + (${LEASE_SECONDS} || ' seconds')::interval,
        attempt_count = j.attempt_count + 1,
        started_at = COALESCE(j.started_at, NOW()), error = NULL
    FROM candidate
    WHERE j.id = candidate.id
    RETURNING j.id, j.request_id, j.width, j.height, j.unit, j.dpi, j.background,
              j.input_key, j.output_key, j.attempt_count, j.lease_expires_at
  `);
  return rows[0] || null;
}

async function responseFor(job: any, workerRunId: string) {
  const expires = 15 * 60;
  const [inputUrl, outputUrl] = await Promise.all([
    createPresignedUrl("GET", job.input_key, expires),
    createPresignedUrl("PUT", job.output_key, expires),
  ]);

  await sql`
    UPDATE photo_jobs
    SET input_url = ${inputUrl}, output_url = ${outputUrl},
        url_expires_at = NOW() + (${expires} || ' seconds')::interval
    WHERE id = ${job.id} AND status = 'processing' AND worker_run_id = ${workerRunId}
  `;

  return NextResponse.json({
    status: "job",
    workerRunId,
    job: {
      id: job.id,
      requestId: job.request_id,
      width: Number(job.width),
      height: Number(job.height),
      unit: job.unit,
      dpi: Number(job.dpi),
      background: job.background,
      inputUrl,
      outputUrl,
      urlExpiresInSeconds: expires,
      attemptCount: Number(job.attempt_count),
      leaseExpiresAt: job.lease_expires_at,
    },
  });
}

export async function POST(request: Request) {
  const worker = await authenticateWorker(request);
  if (!worker) return NextResponse.json({ error: "invalid or expired worker credential" }, { status: 401 });

  try {
    const workerRunId = String(worker.id);
    const direct = await claimNext(workerRunId);
    if (direct) return responseFor(direct, workerRunId);

    let queuedJob: any = null;
    const result = await receive(
      PHOTO_QUEUE_NAME,
      PHOTO_QUEUE_CONSUMER,
      async (message) => {
        const jobId = String((message as { jobId?: string })?.jobId || "");
        if (jobId) queuedJob = await claim(jobId, workerRunId);
      },
      { limit: 1, visibilityTimeoutSeconds: LEASE_SECONDS },
    );

    if (queuedJob) return responseFor(queuedJob, workerRunId);
    return NextResponse.json({ status: "empty", queueResult: result.ok ? "processed-but-not-claimable" : result.reason });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "领取任务失败" }, { status: 500 });
  }
}

// Keep GET temporarily compatible with the previous Lightning worker while it
// migrates to the authenticated POST contract.
export async function GET(request: Request) {
  return POST(request);
}
