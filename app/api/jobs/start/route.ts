import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { createPresignedUrl } from "@/lib/r2";

export const runtime = "nodejs";

const URL_TTL_SECONDS = 2 * 60 * 60;

export async function POST() {
  try {
    const wakeUrl = process.env.LIGHTNING_WAKE_URL;
    const wakeToken = process.env.LIGHTNING_WAKE_TOKEN;
    if (!wakeUrl || !wakeToken) {
      return NextResponse.json({ error: "LIGHTNING_WAKE_URL / LIGHTNING_WAKE_TOKEN 未配置" }, { status: 500 });
    }

    const claimed = await sql.begin(async (tx) => {
      const state = await tx`SELECT status FROM photo_worker_state WHERE id = 1 FOR UPDATE`;
      if (state[0]?.status !== "idle") return { started: false, reason: "already_running" as const, jobs: 0 };

      const jobs = await tx`
        SELECT id, input_key, output_key
        FROM photo_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
      `;
      if (!jobs.length) return { started: false, reason: "empty" as const, jobs: 0 };

      const expiresAt = new Date(Date.now() + URL_TTL_SECONDS * 1000);
      for (const job of jobs) {
        const inputUrl = await createPresignedUrl("GET", job.input_key, URL_TTL_SECONDS);
        const outputUrl = await createPresignedUrl("PUT", job.output_key, URL_TTL_SECONDS);
        await tx`
          UPDATE photo_jobs
          SET input_url = ${inputUrl}, output_url = ${outputUrl}, url_expires_at = ${expiresAt}
          WHERE id = ${job.id}
        `;
      }

      await tx`
        UPDATE photo_worker_state
        SET status = 'starting', started_at = NOW(), updated_at = NOW()
        WHERE id = 1
      `;
      return { started: true, reason: "started" as const, jobs: jobs.length };
    });

    if (!claimed.started) {
      return NextResponse.json({ status: claimed.reason, queued: claimed.jobs }, { status: 200 });
    }

    const wakeResponse = await fetch(wakeUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${wakeToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "photo-queue", jobs: claimed.jobs }),
      cache: "no-store",
    });

    if (!wakeResponse.ok) {
      await sql`
        UPDATE photo_worker_state SET status = 'idle', updated_at = NOW() WHERE id = 1
      `;
      await sql`
        UPDATE photo_jobs SET input_url = NULL, output_url = NULL, url_expires_at = NULL
        WHERE status = 'queued'
      `;
      return NextResponse.json({ error: `唤醒 Lightning 失败 (${wakeResponse.status})` }, { status: 502 });
    }

    await sql`UPDATE photo_worker_state SET status = 'running', updated_at = NOW() WHERE id = 1`;
    return NextResponse.json({ status: "started", jobs: claimed.jobs });
  } catch (error) {
    console.error(error);
    await sql`UPDATE photo_worker_state SET status = 'idle', updated_at = NOW() WHERE id = 1`.catch(() => undefined);
    return NextResponse.json({ error: error instanceof Error ? error.message : "启动处理失败" }, { status: 500 });
  }
}
