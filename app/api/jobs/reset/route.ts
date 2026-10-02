import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { emptyBucket } from "@/lib/r2";
import { getBackendHealth } from "@/lib/backend";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST() {
  try {
    const backend = await getBackendHealth();
    if (!backend.reachable || backend.workerRunId) {
      return NextResponse.json({ error: "处理服务尚未空闲，暂时无法清空照片" }, { status: 409 });
    }
    const result = await sql.begin(async (tx) => {
      // Submit and Start lock this same row. Keep it locked throughout cleanup
      // so concurrent requests cannot upload new objects while they are deleted.
      const state = await tx`SELECT status FROM photo_worker_state WHERE id = 1 FOR UPDATE`;
      const active = await tx`SELECT COUNT(*)::int AS count FROM photo_jobs WHERE status = 'processing'`;
      if (state[0]?.status !== "idle" || Number(active[0]?.count || 0) > 0) return null;
      // A storage failure rolls back the transaction and preserves the records.
      const deletedObjects = await emptyBucket();
      await tx`TRUNCATE TABLE photo_jobs, photo_requests, photo_worker_runs RESTART IDENTITY CASCADE`;
      await tx`
        INSERT INTO photo_worker_state (id, status, active_run_id, started_at, updated_at)
        VALUES (1, 'idle', NULL, NULL, NOW())
        ON CONFLICT (id) DO UPDATE SET
          status = 'idle',
          active_run_id = NULL,
          started_at = NULL,
          updated_at = NOW()
      `;
      return { deletedObjects };
    });
    if (!result) return NextResponse.json({ error: "任务正在处理，完成后才能清空照片" }, { status: 409 });

    return NextResponse.json({
      status: "reset",
      deletedObjects: result.deletedObjects,
      message: "当前任务、历史记录和 R2 图片已全部清除",
    });
  } catch (error) {
    console.error("[JobsReset] failed", error);
    return NextResponse.json({ error: "清空队列、历史记录或 R2 图片失败，请重试" }, { status: 500 });
  }
}
