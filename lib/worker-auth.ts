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
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashWorkerCredential(token: string) {
  return hash(token);
}

export async function authenticateWorker(request: Request) {
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) {
    console.warn("[WorkerAuth] missing or invalid authorization scheme", {
      hasAuthorization: Boolean(header),
    });
    return null;
  }

  const token = header.slice(7).trim();
  if (!token) {
    console.warn("[WorkerAuth] empty bearer token");
    return null;
  }

  const credentialHash = await hash(token);
  const rows = await sql`
    UPDATE photo_worker_runs
    SET last_seen_at = NOW()
    WHERE credential_hash = ${credentialHash}
      AND credential_expires_at > NOW()
      AND status IN ('starting', 'running')
    RETURNING id, status, credential_expires_at
  `;

  if (!rows[0]) {
    // Never log the credential or its hash. This diagnostic intentionally only
    // reports non-secret facts that distinguish the common 401 causes.
    const diagnostics = await sql`
      SELECT
        COUNT(*)::int AS total_runs,
        COUNT(*) FILTER (WHERE credential_hash = ${credentialHash})::int AS matching_hash,
        COUNT(*) FILTER (WHERE credential_hash = ${credentialHash} AND credential_expires_at <= NOW())::int AS matching_but_expired,
        COUNT(*) FILTER (WHERE credential_hash = ${credentialHash} AND status NOT IN ('starting', 'running'))::int AS matching_but_inactive
      FROM photo_worker_runs
    `;
    console.warn("[WorkerAuth] credential rejected", {
      tokenLength: token.length,
      totalRuns: Number(diagnostics[0]?.total_runs || 0),
      matchingHash: Number(diagnostics[0]?.matching_hash || 0),
      matchingButExpired: Number(diagnostics[0]?.matching_but_expired || 0),
      matchingButInactive: Number(diagnostics[0]?.matching_but_inactive || 0),
    });
    return null;
  }

  return rows[0];
}

export function credentialExpiryDate() {
  return new Date(Date.now() + DEFAULT_CREDENTIAL_TTL_SECONDS * 1000);
}
