import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "./client.js";

const MIGRATION_LOCK_KEY = "discord-music-migrations";

export type MigrationResult = { applied: number; folder: string };

/**
 * Build the candidate locations for the Drizzle migrations folder.
 *
 * The folder is committed once under `packages/shared/drizzle` and read both
 * from the repo root during development and from `/app/packages/shared/drizzle`
 * inside the web image (same relative depth from `import.meta.dir`).
 */
export function migrationFolderCandidates(
  env: NodeJS.ProcessEnv = process.env,
  moduleDir: string = import.meta.dir,
): string[] {
  const candidates = [
    env.MIGRATIONS_DIR,
    resolve(moduleDir, "../../../../../packages/shared/drizzle"),
    resolve(process.cwd(), "packages/shared/drizzle"),
    resolve(process.cwd(), "drizzle"),
    "/app/packages/shared/drizzle",
  ];
  return [...new Set(candidates.filter((value): value is string => Boolean(value)))];
}

function isMigrationsFolder(candidate: string): boolean {
  return existsSync(join(candidate, "meta", "_journal.json"));
}

export function resolveMigrationsFolder(
  env: NodeJS.ProcessEnv = process.env,
  moduleDir: string = import.meta.dir,
): string {
  const candidates = migrationFolderCandidates(env, moduleDir);
  for (const candidate of candidates) {
    if (isMigrationsFolder(candidate)) return candidate;
  }
  const tried = candidates.map((candidate) => `  - ${candidate}`).join("\n");
  throw new Error(`Could not locate the Drizzle migrations folder. Tried:\n${tried}`);
}

async function appliedMigrationCount(): Promise<number> {
  try {
    const rows = await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    const row = rows[0] as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  } catch {
    // The bookkeeping table does not exist before the first migration.
    return 0;
  }
}

/**
 * Apply every pending migration while holding a Postgres advisory lock, so
 * rolling web replicas boot one at a time instead of racing DDL.
 *
 * The lock is pinned to one reserved connection: advisory locks are
 * session-scoped, so locking through the shared pool could unlock a different
 * connection and silently leak the lock across replicas.
 */
export async function runMigrations(): Promise<MigrationResult> {
  const folder = resolveMigrationsFolder();

  const reserved = await sql.reserve();
  try {
    await reserved`SELECT pg_advisory_lock(hashtext(${MIGRATION_LOCK_KEY}))`;
    const before = await appliedMigrationCount();
    await migrate(db, { migrationsFolder: folder });
    const after = await appliedMigrationCount();
    return { applied: Math.max(after - before, 0), folder };
  } finally {
    try {
      await reserved`SELECT pg_advisory_unlock(hashtext(${MIGRATION_LOCK_KEY}))`;
    } finally {
      reserved.release();
    }
  }
}
