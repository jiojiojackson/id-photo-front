import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required for database migrations.");
  process.exit(1);
}

const migrationsDir = path.resolve(process.cwd(), "db/migrations");
const sql = postgres(databaseUrl, {
  max: 1,
  prepare: false,
  connect_timeout: 10,
});

try {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Prevent concurrent Vercel builds from applying the same migration twice.
  await sql`SELECT pg_advisory_lock(hashtext('id-photo-front:migrations'))`;

  const files = (await fs.readdir(migrationsDir))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (files.length === 0) {
    console.log("No database migrations found.");
    process.exit(0);
  }

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const [existing] = await sql`
      SELECT version FROM schema_migrations WHERE version = ${version}
    `;

    if (existing) {
      console.log(`✓ ${version} already applied`);
      continue;
    }

    const migration = await fs.readFile(path.join(migrationsDir, file), "utf8");
    console.log(`→ Applying ${version}`);

    await sql.begin(async (tx) => {
      await tx.unsafe(migration);
      await tx`
        INSERT INTO schema_migrations (version) VALUES (${version})
      `;
    });

    console.log(`✓ ${version} applied`);
  }
} catch (error) {
  console.error("Database migration failed:", error);
  process.exitCode = 1;
} finally {
  try {
    await sql`SELECT pg_advisory_unlock(hashtext('id-photo-front:migrations'))`;
  } catch {
    // Ignore unlock errors when connection setup itself failed.
  }
  await sql.end({ timeout: 5 });
}
