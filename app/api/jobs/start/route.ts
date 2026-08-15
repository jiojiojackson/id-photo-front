import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { createWorkerCredential, credentialExpiryDate, hashWorkerCredential } from "@/lib/worker-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let workerRunId: string | null = null;

  try {
    const lightningUrl = process.env.LIGHTNING_API_URL;
    const lightningKey = process.env.LIGHTNING_API_KEY;
    if (!lightningUrl || !lightningKey) {
      return NextResponse.json({ error: "LIGHTNING_API_URL 或 LIGHTNING_API_KEY 未配置" }, { status: 500 });
    }

    const credential = createWorkerCredential();
    const credentialHash = await hashWorkerCredential(credential);
    const expiresAt = credentialExpiryDate();

    const claimed = await sql.begin(async (tx) => {
      const state = await tx`
        SELECT status, active_run_id
        FROM photo_worker_state
        WHERE id = 1
        FOR UPDATE
      `;

      if (state[0]?.status !== "idle" && state[0]?.active_run_id) {
        const active = await tx`
          SELECT status, credential_expires_at
          FROM photo_worker_runs
          WHERE id = ${String(state[0].active_run_id)}
          FOR UPDATE
        `;
        const expired = !active[0] || active[0].status IN ('completed','failed') || new Date(active[0].credential_expires_at).getTime() <= Date.now();
        if (!expired) return { started: false, reason: "already_running" as const, count: 0 };

        await tx`
          UPDATE photo_worker_runs
          SET status = 'failed', finished_at = NOW(), error = 'worker credential expired or run became stale'
          WHERE id = ${String(state[0].active_run_id)} AND status IN ('starting','running')
        `;
        await tx`
          UPDATE photo_worker_state
          SET status = 'idle', active_run_id = NULL, updated_at = NOW()
          WHERE id = 1
        `;
      } else if (state[0]?.status !== "idle") {
        await tx`UPDATE photo_worker_state SET status = 'idle', active_run_id = NULL, updated_at = NOW() WHERE id = 1`;
      }

      const pending = await tx`
        SELECT COUNT(*)::int AS count
        FROM photo_jobs
        WHERE status = 'queued'
           OR (status = 'processing' AND lease_expires_at <= NOW())
      `;
      const count = Number(pending[0]?.count || 0);
      if (!count) return { started: false, reason: "empty" as const, count: 0 };

      workerRunId = crypto.randomUUID();
      await tx`
        INSERT INTO photo_worker_runs
          (id, credential_hash, credential_expires_at, status)
        VALUES
          (${workerRunId}, ${credentialHash}, ${expiresAt}, 'starting')
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

    // Lightning is stateless. It receives everything it needs for this run;
    // the application itself does not need LIGHTNING_* environment variables.
    const bridgeUrl = new URL("/api/worker", request.url).toString();
    const wakeResponse = await fetch(lightningUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Platform-issued credential used only by Vercel to wake Lightning.
        Authorization: `Bearer ${lightningKey}`,
      },
      body: JSON.stringify({
        worker_run_id: workerRunId,
        bridge_url: bridgeUrl,
        worker_credential: credential,
        worker_credential_expires_at: expiresAt.toISOString(),
      }),
      cache: "no-store",
    });

    if (!wakeResponse.ok) {
      await sql.begin(async (tx) => {
        await tx`UPDATE photo_worker_runs SET status = 'failed', finished_at = NOW(), error = ${`Lightning wake failed: ${wakeResponse.status}`} WHERE id = ${workerRunId}`;
        await tx`UPDATE photo_worker_state SET status = 'idle', active_run_id = NULL, updated_at = NOW() WHERE id = 1 AND active_run_id = ${workerRunId}`;
      });
      return NextResponse.json({ error: `启动 Lightning 失败 (${wakeResponse.status})` }, { status: 502 });
    }

    await sql.begin(async (tx) => {
      await tx`UPDATE photo_worker_runs SET status = 'running' WHERE id = ${workerRunId} AND status = 'starting'`;
      await tx`UPDATE photo_worker_state SET status = 'running', updated_at = NOW() WHERE id = 1 AND active_run_id = ${workerRunId}`;
    });

    return NextResponse.json({
      status: "started",
      workerRunId,
      jobs: claimed.count,
      credentialExpiresAt: expiresAt.toISOString(),
      estimatedSeconds: await estimateSeconds(claimed.count),
    });
  } catch (error) {
    console.error(error);
    if (workerRunId) {
      await sql`UPDATE photo_worker_runs SET status = 'failed', finished_at = NOW(), error = ${error instanceof Error ? error.message : "启动处理失败"} WHERE id = ${workerRunId} AND status IN ('starting','running')`.catch(() => undefined);
      await sql`UPDATE photo_worker_state SET status = 'idle', active_run_id = NULL, updated_at = NOW() WHERE id = 1 AND active_run_id = ${workerRunId}`.catch(() => undefined);
    }
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
