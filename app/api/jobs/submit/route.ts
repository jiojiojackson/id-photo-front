import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { inputKey, outputKey, putObject } from "@/lib/r2";
import { enqueueJob } from "@/lib/queue";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

function validDimension(value: unknown) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 100 && n <= 3000 ? n : null;
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const image = form.get("image");
    const sizesRaw = form.get("sizes");
    const dpi = Number(form.get("dpi") || 300);
    const background = String(form.get("background") || "#ffffff");

    if (!(image instanceof File)) return NextResponse.json({ error: "image is required" }, { status: 400 });
    if (image.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "照片压缩后仍超过 2 MB" }, { status: 413 });

    let sizes: Array<{ width: number; height: number }>;
    try { sizes = JSON.parse(String(sizesRaw || "[]")); } catch { sizes = []; }
    sizes = sizes
      .map((s) => ({ width: validDimension(s?.width), height: validDimension(s?.height) }))
      .filter((s): s is { width: number; height: number } => s.width !== null && s.height !== null);
    if (!sizes.length || sizes.length > 10) return NextResponse.json({ error: "请选择 1～10 个有效尺寸" }, { status: 400 });

    const requestId = crypto.randomUUID();
    const originalKey = inputKey(requestId);

    // Upload directly with SigV4. Processing presigned URLs are generated only
    // after the user clicks Start, so they cannot expire while waiting in queue.
    await putObject(originalKey, await image.arrayBuffer(), image.type || "image/jpeg");

    await sql`INSERT INTO photo_requests (id) VALUES (${requestId})`;
    const jobs: string[] = [];
    for (const size of sizes) {
      const jobId = crypto.randomUUID();
      jobs.push(jobId);
      await sql`
        INSERT INTO photo_jobs
          (id, request_id, width, height, unit, dpi, background, input_key, output_key)
        VALUES
          (${jobId}, ${requestId}, ${size.width}, ${size.height}, 'px', ${Number.isInteger(dpi) ? dpi : 300}, ${background}, ${originalKey}, ${outputKey(jobId)})
      `;
    }

    for (const jobId of jobs) await enqueueJob(jobId);

    const count = await sql`SELECT COUNT(*)::int AS count FROM photo_jobs WHERE status = 'queued'`;
    return NextResponse.json({ requestId, jobIds: jobs, queued: count[0].count });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "提交任务失败" }, { status: 500 });
  }
}
