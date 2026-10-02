import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { authenticateWorker } from "@/lib/worker-auth";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const worker = await authenticateWorker(request);
  if (!worker) return NextResponse.json({ error: "invalid or expired worker credential" }, { status: 401 });
  const { jobId } = await params;
  const result = await sql`
    UPDATE photo_jobs
    SET status = 'processing', started_at = COALESCE(started_at, NOW()),
        worker_run_id = ${String(worker.id)}, claimed_at = NOW(),
        lease_expires_at = NOW() + INTERVAL '10 minutes', attempt_count = attempt_count + 1
    WHERE id = ${jobId} AND status = 'queued'
    RETURNING id
  `;
  if (!result.length) return NextResponse.json({ ok: false, reason: "not_queued" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
