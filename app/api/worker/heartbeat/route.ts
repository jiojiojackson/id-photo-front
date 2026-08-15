import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { authenticateWorker } from "@/lib/worker-auth";

export const runtime = "nodejs";

const LEASE_EXTENSION_SECONDS = 10 * 60;

type LeaseRow = { lease_expires_at: Date | string };

export async function POST(request: Request) {
  const worker = await authenticateWorker(request);
  if (!worker) return NextResponse.json({ error: "invalid or expired worker credential" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const jobId = String(body.jobId || "");
  if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });

  const runId = String(worker.id);
  const rows = await sql.begin(async (tx) => {
    const leaseRows = await tx<LeaseRow[]>`
      UPDATE photo_jobs
      SET lease_expires_at = NOW() + (${LEASE_EXTENSION_SECONDS} || ' seconds')::interval
      WHERE id = ${jobId}
        AND status = 'processing'
        AND worker_run_id = ${runId}
        AND lease_expires_at > NOW()
      RETURNING lease_expires_at
    `;

    if (!leaseRows.length) return [] as LeaseRow[];

    await tx`
      UPDATE photo_worker_runs
      SET last_seen_at = NOW()
      WHERE id = ${runId} AND status IN ('starting', 'running')
    `;

    return leaseRows;
  });

  if (!rows.length) return NextResponse.json({ error: "job lease is no longer valid" }, { status: 409 });
  return NextResponse.json({ ok: true, leaseExpiresAt: rows[0].lease_expires_at });
}
