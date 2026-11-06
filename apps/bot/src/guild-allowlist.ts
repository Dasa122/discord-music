/**
 * Optional guild allow-list.
 *
 * `DISCORD_ALLOWED_GUILD_IDS` is a comma-separated list; empty (or unset)
 * means "every guild the bot has been invited to". Interactions from any
 * other guild are dropped before a command or button runs.
 */
export function parseAllowedGuildIds(value: string | undefined | null): string[] {
  if (!value) return [];
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return [...new Set(ids)];
}

/** `null` (a DM) is not a guild and falls through to the per-command checks. */
export function isGuildAllowed(allowed: readonly string[], guildId: string | null): boolean {
  if (allowed.length === 0) return true;
  if (guildId === null) return true;
  return allowed.includes(guildId);
}
