import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1 });

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
  console.log("Database reset complete: jobs, requests and worker runs cleared; worker state reset to idle.");
} finally {
  await sql.end();
}
