import postgres from "postgres";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not configured");
}

export const sql = postgres(process.env.DATABASE_URL, { ssl: "verify-full" });
