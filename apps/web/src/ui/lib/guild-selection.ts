export const SELECTED_GUILD_STORAGE_KEY = "music:selectedGuild";

/**
 * Resolves which guild the dashboard should control.
 *
 * Priority:
 * 1. `?guild=` from the URL — the URL is the source of truth when present.
 * 2. The guild persisted in localStorage, but only if it is still available.
 * 3. The first guild the bot is in.
 *
 * The URL value is deliberately not validated against the list: a guild id the
 * bot is not in should still render the "Bot is not in this guild" guard rather
 * than silently selecting a different server.
 */
export function resolveSelectedGuildId(
  urlGuild: string | null,
  storedGuild: string | null,
  guildIds: readonly string[],
): string | null {
  const trimmedUrlGuild = urlGuild?.trim();
  if (trimmedUrlGuild) {
    return trimmedUrlGuild;
  }

  const trimmedStoredGuild = storedGuild?.trim();
  if (trimmedStoredGuild && guildIds.includes(trimmedStoredGuild)) {
    return trimmedStoredGuild;
  }

  return guildIds[0] ?? null;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredGuild(): string | null {
  const storage = getStorage();
  if (!storage) {
    return null;
  }
  try {
    return storage.getItem(SELECTED_GUILD_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredGuild(guildId: string | null): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }
  try {
    if (guildId) {
      storage.setItem(SELECTED_GUILD_STORAGE_KEY, guildId);
    } else {
      storage.removeItem(SELECTED_GUILD_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable in private modes; the URL still works.
  }
}

/** Appends the selected guild to an internal link so the choice survives navigation. */
export function withGuild(path: string, guildId: string | null): string {
  if (!guildId) {
    return path;
  }
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}guild=${encodeURIComponent(guildId)}`;
}
