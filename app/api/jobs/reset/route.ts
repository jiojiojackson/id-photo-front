import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";

export async function POST() {
  try {
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

    return NextResponse.json({ status: "reset", message: "当前任务和历史记录已清除" });
  } catch (error) {
    console.error("[JobsReset] failed", error);
    return NextResponse.json({ error: "清除历史记录失败" }, { status: 500 });
  }
}
