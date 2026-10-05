import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { createWorkerCredential, credentialExpiryDate, hashWorkerCredential } from "@/lib/worker-auth";
import { backendConfig, isBackendLocation } from "@/lib/backend";

export const runtime = "nodejs";
// The persistent backend acknowledges the run before starting inference.
export const maxDuration = 60;

const WORKER_STALE_SECONDS = 120;

export async function POST(request: NextRequest) {
  let workerRunId: string | null = null;

  try {
    const body = await request.json().catch(() => ({}));
    const location = body.backend ?? "oracle";
    if (!isBackendLocation(location)) return NextResponse.json({ error: "请选择 Oracle 或 Modal 处理位置" }, { status: 400 });
    const backend = backendConfig(location);

    const credential = createWorkerCredential();
    const credentialHash = await hashWorkerCredential(credential);
    const expiresAt = credentialExpiryDate();

    const claimed = await sql.begin(async (tx) => {
      const state = await tx`SELECT status, active_run_id FROM photo_worker_state WHERE id = 1 FOR UPDATE`;

      if (state[0]?.status !== "idle" && state[0]?.active_run_id) {
        const active = await tx`
          SELECT status, backend, credential_expires_at, last_seen_at
          FROM photo_worker_runs
          WHERE id = ${String(state[0].active_run_id)}
          FOR UPDATE
        `;
        const lastSeen = active[0]?.last_seen_at ? new Date(active[0].last_seen_at).getTime() : 0;
        const staleSeconds = active[0]?.backend === "modal" && active[0]?.status === "starting" ? 600 : WORKER_STALE_SECONDS;
        const stale = !active[0]
          || ["completed", "failed"].includes(String(active[0].status))
          || new Date(active[0].credential_expires_at).getTime() <= Date.now()
          || lastSeen < Date.now() - staleSeconds * 1000;
        if (!stale) return { started: false, reason: "already_running" as const, count: 0 };

        const staleRunId = String(state[0].active_run_id);
        const staleError = `Worker Run 已失联超过 ${WORKER_STALE_SECONDS} 秒，后端可能已停止。`;
        await tx`
          UPDATE photo_jobs
          SET status = 'failed', error = ${staleError}, completed_at = NOW(),
              worker_run_id = NULL, claimed_at = NULL, lease_expires_at = NULL,
              input_url = NULL, output_url = NULL, url_expires_at = NULL
          WHERE worker_run_id = ${staleRunId} AND status = 'processing'
        `;
        await tx`
          UPDATE photo_worker_runs
          SET status = 'failed', finished_at = NOW(), error = ${staleError}
          WHERE id = ${staleRunId} AND status IN ('starting','running')
        `;
        await tx`UPDATE photo_worker_state SET status = 'idle', active_run_id = NULL, updated_at = NOW() WHERE id = 1 AND active_run_id = ${staleRunId}`;
      } else if (state[0]?.status !== "idle") {
        await tx`UPDATE photo_worker_state SET status = 'idle', active_run_id = NULL, updated_at = NOW() WHERE id = 1`;
      }

      const pending = await tx`
        SELECT COUNT(*)::int AS count
        FROM photo_jobs
        WHERE status = 'queued'
      `;
      const count = Number(pending[0]?.count || 0);
      if (!count) return { started: false, reason: "empty" as const, count: 0 };

      workerRunId = crypto.randomUUID();
      await tx`
        INSERT INTO photo_worker_runs (id, credential_hash, credential_expires_at, status, backend)
        VALUES (${workerRunId}, ${credentialHash}, ${expiresAt}, 'starting', ${location})
      `;
      await tx`
        UPDATE photo_worker_state
        SET status = 'starting', active_run_id = ${workerRunId}, started_at = NOW(), updated_at = NOW()
        WHERE id = 1
      `;
      return { started: true, reason: "started" as const, count };
    });

    if (!claimed.started || !workerRunId) {
      return NextResponse.json({ status: claimed.reason, queued: claimed.count }, { status: 200 });
    }

    const vercelOrigin = request.nextUrl.origin;
    const bridgeUrl = `${vercelOrigin}/api/worker`;
    backend.url.pathname = backend.url.pathname.replace(/\/$/, "") + "/process-queue";
    const wakeResponse = await fetch(backend.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...backend.headers,
      },
      body: JSON.stringify({
        worker_run_id: workerRunId,
        bridge_url: bridgeUrl,
        vercel_origin: vercelOrigin,
        worker_credential: credential,
        worker_credential_expires_at: expiresAt.toISOString(),
      }),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });

    const acknowledgement = await wakeResponse.json().catch(() => null);
    if (!wakeResponse.ok || !["started", "already_running"].includes(acknowledgement?.status) || acknowledgement?.worker_run_id !== workerRunId) {
      const errorMessage = `处理服务未接受本次任务 (HTTP ${wakeResponse.status})`;
      console.error("[WorkerStart]", errorMessage);
      await sql.begin(async (tx) => {
        await tx`SELECT id FROM photo_worker_state WHERE id = 1 FOR UPDATE`;
        await tx`UPDATE photo_worker_runs SET status = 'failed', finished_at = NOW(), error = ${errorMessage} WHERE id = ${workerRunId}`;
        await tx`UPDATE photo_worker_state SET status = 'idle', active_run_id = NULL, updated_at = NOW() WHERE id = 1 AND active_run_id = ${workerRunId}`;
      });
      return NextResponse.json({ error: `启动处理服务失败 (${wakeResponse.status})` }, { status: 502 });
    }

    if (location === "oracle") {
      await sql.begin(async (tx) => {
        await tx`SELECT id FROM photo_worker_state WHERE id = 1 FOR UPDATE`;
        await tx`UPDATE photo_worker_runs SET status = 'running', last_seen_at = NOW() WHERE id = ${workerRunId} AND status = 'starting'`;
        await tx`UPDATE photo_worker_state SET status = 'running', updated_at = NOW() WHERE id = 1 AND active_run_id = ${workerRunId}`;
      });
    }

    return NextResponse.json({
      status: "started",
      backend: location,
      workerRunId,
      jobs: claimed.count,
      credentialExpiresAt: expiresAt.toISOString(),
      estimatedSeconds: await estimateSeconds(claimed.count),
    });
  } catch (error) {
    console.error(error);
    // A fetch timeout/connection close is indeterminate: the request may have
    // reached the backend and inference may still be running. Do not revoke its
    // credential here. Heartbeats keep a live run fresh; status reconciliation
    // safely marks it failed after WORKER_STALE_SECONDS if it never started or
    // later disappeared.
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
