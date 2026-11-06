import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { readStoredGuild, resolveSelectedGuildId, writeStoredGuild } from "./guild-selection";
import { useGuilds } from "./queries";

/**
 * Single source of truth for the selected guild across the dashboard.
 * URL (`?guild=`) wins, then localStorage, then the first guild.
 */
export function useGuildSelection() {
  const guildsQuery = useGuilds();
  const [searchParams, setSearchParams] = useSearchParams();
  const [storedGuild, setStoredGuild] = useState<string | null>(() => readStoredGuild());

  const guilds = useMemo(() => guildsQuery.data ?? [], [guildsQuery.data]);
  const guildIds = useMemo(() => guilds.map((guild) => guild.id), [guilds]);
  const urlGuild = searchParams.get("guild");
  const guildId = resolveSelectedGuildId(urlGuild, storedGuild, guildIds);
  const guild = guildId ? (guilds.find((entry) => entry.id === guildId) ?? null) : null;

  useEffect(() => {
    if (!guildId || !guildIds.includes(guildId) || storedGuild === guildId) {
      return;
    }
    writeStoredGuild(guildId);
    setStoredGuild(guildId);
  }, [guildId, guildIds, storedGuild]);

  const selectGuild = useCallback(
    (nextGuildId: string) => {
      writeStoredGuild(nextGuildId);
      setStoredGuild(nextGuildId);
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set("guild", nextGuildId);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return {
    guildId,
    guild,
    guilds,
    isLoading: guildsQuery.isLoading,
    isError: guildsQuery.isError,
    error: guildsQuery.error,
    refetch: guildsQuery.refetch,
    selectGuild,
  };
}
