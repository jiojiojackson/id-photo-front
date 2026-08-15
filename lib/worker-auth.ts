import { sql } from "@/lib/db";

const DEFAULT_CREDENTIAL_TTL_SECONDS = 4 * 60 * 60;

async function hash(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createWorkerCredential() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return token;
}

export async function hashWorkerCredential(token: string) {
  return hash(token);
}

export async function authenticateWorker(request: Request) {
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;

  const credentialHash = await hash(token);
  const rows = await sql`
    SELECT id, status, credential_expires_at
    FROM photo_worker_runs
    WHERE credential_hash = ${credentialHash}
      AND credential_expires_at > NOW()
      AND status IN ('starting', 'running')
    LIMIT 1
  `;
  return rows[0] || null;
}

export function credentialExpiryDate() {
  return new Date(Date.now() + DEFAULT_CREDENTIAL_TTL_SECONDS * 1000);
}
