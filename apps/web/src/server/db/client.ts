import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";

/**
 * One process-wide postgres.js pool. postgres.js connects lazily, so importing
 * this module does not open a socket until the first query runs.
 */
export const sql = postgres(config.databaseUrl, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: () => {},
});

export const db = drizzle(sql);

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
