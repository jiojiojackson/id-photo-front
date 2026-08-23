import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { emptyBucket } from "@/lib/r2";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST() {
  try {
    // Delete R2 first so a storage failure leaves the database records available
    // for a safe retry instead of stranding objects with no corresponding jobs.
    const deletedObjects = await emptyBucket();

    await sql.begin(async (tx) => {
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
    });

    return NextResponse.json({
      status: "reset",
      deletedObjects,
      message: "当前任务、历史记录和 R2 图片已全部清除",
    });
  } catch (error) {
    console.error("[JobsReset] failed", error);
    return NextResponse.json({ error: "清空队列、历史记录或 R2 图片失败，请重试" }, { status: 500 });
  }
}
