import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { createWorkerCredential, credentialExpiryDate, hashWorkerCredential } from "@/lib/worker-auth";

export const runtime = "nodejs";

const WORKER_STALE_SECONDS = 120;

export async function POST(request: NextRequest) {
  let workerRunId: string | null = null;

  try {
    const lightningUrl = process.env.LIGHTNING_API_URL;
    const debugDirectBackend = process.env.DEBUG_DIRECT_BACKEND === "true";
    const lightningKey = process.env.LIGHTNING_API_KEY;
    if (!lightningUrl) {
      return NextResponse.json({ error: "LIGHTNING_API_URL 未配置" }, { status: 500 });
    }
    // Debug mode is intended for the Linux/Lightning Studio FastAPI instance.
    // That server is directly exposed and does not use the Lightning platform API key.
    if (!debugDirectBackend && !lightningKey) {
      return NextResponse.json({ error: "LIGHTNING_API_KEY 未配置" }, { status: 500 });
    }

    const credential = createWorkerCredential();
    const credentialHash = await hashWorkerCredential(credential);
    const expiresAt = credentialExpiryDate();

    const claimed = await sql.begin(async (tx) => {
      const state = await tx`SELECT status, active_run_id FROM photo_worker_state WHERE id = 1 FOR UPDATE`;

      if (state[0]?.status !== "idle" && state[0]?.active_run_id) {
        const active = await tx`
          SELECT status, credential_expires_at, last_seen_at
          FROM photo_worker_runs
          WHERE id = ${String(state[0].active_run_id)}
          FOR UPDATE
        `;
        const lastSeen = active[0]?.last_seen_at ? new Date(active[0].last_seen_at).getTime() : 0;
        const stale = !active[0]
          || ["completed", "failed"].includes(String(active[0].status))
          || new Date(active[0].credential_expires_at).getTime() <= Date.now()
          || lastSeen < Date.now() - WORKER_STALE_SECONDS * 1000;
        if (!stale) return { started: false, reason: "already_running" as const, count: 0 };

        await tx`
          UPDATE photo_worker_runs
          SET status = 'failed', finished_at = NOW(), error = 'worker became stale or credential expired'
          WHERE id = ${String(state[0].active_run_id)} AND status IN ('starting','running')
        `;
        await tx`UPDATE photo_worker_state SET status = 'idle', active_run_id = NULL, updated_at = NOW() WHERE id = 1`;
      } else if (state[0]?.status !== "idle") {
        await tx`UPDATE photo_worker_state SET status = 'idle', active_run_id = NULL, updated_at = NOW() WHERE id = 1`;
      }

      const pending = await tx`
        SELECT COUNT(*)::int AS count
        FROM photo_jobs
        WHERE status = 'queued' OR (status = 'processing' AND lease_expires_at <= NOW())
      `;
      const count = Number(pending[0]?.count || 0);
      if (!count) return { started: false, reason: "empty" as const, count: 0 };

      workerRunId = crypto.randomUUID();
      await tx`
        INSERT INTO photo_worker_runs (id, credential_hash, credential_expires_at, status)
        VALUES (${workerRunId}, ${credentialHash}, ${expiresAt}, 'starting')
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

    // In production, Lightning_API_KEY authenticates the platform wake request.
    // In debug mode, the URL points directly to the FastAPI server in Lightning Studio,
    // so no platform Authorization header is sent.
    const bridgeUrl = new URL("/api/worker", request.url).toString();
    const wakeHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (!debugDirectBackend) {
      wakeHeaders.Authorization = `Bearer ${lightningKey}`;
    }

    const wakeResponse = await fetch(buildLightningProcessQueueUrl(lightningUrl), {
      method: "POST",
      headers: wakeHeaders,
      body: JSON.stringify({
        worker_run_id: workerRunId,
        bridge_url: bridgeUrl,
        worker_credential: credential,
        worker_credential_expires_at: expiresAt.toISOString(),
      }),
      cache: "no-store",
    });

    if (!wakeResponse.ok) {
      const responseBody = await wakeResponse.text().catch(() => "");
      const errorMessage = [
        `Lightning wake failed: HTTP ${wakeResponse.status}`,
        wakeResponse.statusText ? `(${wakeResponse.statusText})` : "",
        responseBody ? `body=${responseBody.slice(0, 1000)}` : "",
      ].filter(Boolean).join(" ");

      console.error("[WorkerStart]", errorMessage);
      await sql.begin(async (tx) => {
        await tx`UPDATE photo_worker_runs SET status = 'failed', finished_at = NOW(), error = ${errorMessage} WHERE id = ${workerRunId}`;
        await tx`UPDATE photo_worker_state SET status = 'idle', active_run_id = NULL, updated_at = NOW() WHERE id = 1 AND active_run_id = ${workerRunId}`;
      });
      return NextResponse.json({ error: `启动 Lightning 失败 (${wakeResponse.status})` }, { status: 502 });
    }

    await sql.begin(async (tx) => {
      await tx`UPDATE photo_worker_runs SET status = 'running', last_seen_at = NOW() WHERE id = ${workerRunId} AND status = 'starting'`;
      await tx`UPDATE photo_worker_state SET status = 'running', updated_at = NOW() WHERE id = 1 AND active_run_id = ${workerRunId}`;
    });

    return NextResponse.json({
      status: "started",
      workerRunId,
      jobs: claimed.count,
      credentialExpiresAt: expiresAt.toISOString(),
      estimatedSeconds: await estimateSeconds(claimed.count),
      debugDirectBackend,
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

function buildLightningProcessQueueUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith("/process-queue")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/process-queue`;
  }
  return url.toString();
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
