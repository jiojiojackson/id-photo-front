import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { createPresignedUrl } from "@/lib/r2";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const jobId = request.nextUrl.searchParams.get("jobId");
    if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    const rows = await sql`SELECT output_key, status FROM photo_jobs WHERE id = ${jobId} LIMIT 1`;
    if (!rows.length || rows[0].status !== "completed") return NextResponse.json({ error: "结果不存在" }, { status: 404 });
    const url = await createPresignedUrl("GET", String(rows[0].output_key), 300);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return NextResponse.json({ error: "读取结果图片失败" }, { status: 502 });
    return new NextResponse(await response.arrayBuffer(), {
      headers: {
        "Content-Type": response.headers.get("content-type") || "image/png",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    console.error("[JobImage]", error);
    return NextResponse.json({ error: "读取结果图片失败" }, { status: 500 });
  }
}
