import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { createPresignedUrl } from "@/lib/r2";
import { receive, PHOTO_QUEUE_CONSUMER, PHOTO_QUEUE_NAME } from "@/lib/queue";

export const runtime = "nodejs";

export async function GET(_request: NextRequest) {
  let selectedJob: any = null;

  const result = await receive(
    PHOTO_QUEUE_NAME,
    PHOTO_QUEUE_CONSUMER,
    async (message) => {
      const jobId = String((message as { jobId?: string })?.jobId || "");
      if (!jobId) throw new Error("Queue message does not contain jobId");

      const rows = await sql`
        SELECT id, request_id, width, height, unit, dpi, background,
               input_key, output_key, status
        FROM photo_jobs
        WHERE id = ${jobId}
      `;
      if (!rows.length) throw new Error(`Job not found: ${jobId}`);

      const job = rows[0];
      if (job.status !== "queued") {
        selectedJob = { jobId: String(job.id), skip: true, status: job.status };
        return;
      }

      // Presigned URLs are created only when Lightning actually asks for the job.
      const inputUrl = await createPresignedUrl("GET", job.input_key, 30 * 60);
      const outputUrl = await createPresignedUrl("PUT", job.output_key, 30 * 60);
      await sql`
        UPDATE photo_jobs
        SET input_url = ${inputUrl},
            output_url = ${outputUrl},
            url_expires_at = NOW() + INTERVAL '30 minutes'
        WHERE id = ${job.id} AND status = 'queued'
      `;

      selectedJob = {
        jobId: String(job.id),
        requestId: String(job.request_id),
        width: Number(job.width),
        height: Number(job.height),
        unit: job.unit,
        dpi: Number(job.dpi),
        background: job.background,
        inputUrl,
        outputUrl,
      };
    },
    { limit: 1, visibilityTimeoutSeconds: 300 },
  );

  if (!result.ok || !selectedJob) return new NextResponse(null, { status: 204 });
  return NextResponse.json({ job: selectedJob });
}
