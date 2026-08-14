import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";

export async function POST() {
  await sql`UPDATE photo_worker_state SET status = 'idle', updated_at = NOW() WHERE id = 1`;
  return NextResponse.json({ ok: true });
}
