import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { authenticateWorker } from "@/lib/worker-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const worker = await authenticateWorker(request);
  if (!worker) return NextResponse.json({ error: "invalid or expired worker credential" }, { status: 401 });

  const runId = String(worker.id);
  await sql.begin(async (tx) => {
    await tx`
      UPDATE photo_worker_runs
      SET status = 'completed', finished_at = NOW()
      WHERE id = ${runId} AND status IN ('starting','running')
    `;
    await tx`
      UPDATE photo_worker_state
      SET status = 'idle', active_run_id = NULL, updated_at = NOW()
      WHERE id = 1 AND active_run_id = ${runId}
    `;
  });
  return NextResponse.json({ ok: true });
}
