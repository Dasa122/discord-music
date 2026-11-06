/**
 * Postgres error helpers.
 *
 * Unique-violation detection has to survive both driver shapes: postgres.js
 * surfaces SQLSTATE as `code` (string) with the raw numeric value on `errno`,
 * and wrappers may only expose the real error through `cause`.
 */

const UNIQUE_VIOLATION = "23505";

function asSqlState(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

export function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as Record<string, unknown>;

    if (asSqlState(candidate.code) === UNIQUE_VIOLATION) return true;
    if (asSqlState(candidate.errno) === UNIQUE_VIOLATION) return true;
    if (asSqlState(candidate.sqlState) === UNIQUE_VIOLATION) return true;
    if (
      typeof candidate.constraint === "string" &&
      candidate.constraint.includes("playlist_guild_id_name_unique")
    ) {
      return true;
    }

    current = candidate.cause;
  }

  return false;
}
