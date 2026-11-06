import { randomUUID } from "node:crypto";
import {
  type GuildSettings,
  guildSettings as guildSettingsTable,
  playHistory as playHistoryTable,
  playlistItem as playlistItemTable,
  playlist as playlistTable,
} from "@music/shared";
import { and, asc, count, desc, eq, type InferSelectModel } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";

const sqlClient = postgres(config.databaseUrl, {
  max: 5,
  idle_timeout: 20,
});

export const db = drizzle(sqlClient);

export async function pingDb(): Promise<void> {
  await sqlClient.unsafe("select 1");
}

export async function closeDb(): Promise<void> {
  await sqlClient.end({ timeout: 5 });
}

export interface PlaylistSummary {
  id: string;
  name: string;
  ownerDiscordId: string;
  isShared: boolean;
}

export interface PlaylistItemSummary {
  id: string;
  position: number;
  title: string;
  url: string;
  durationSec: number | null;
  thumbnailUrl: string | null;
  addedBy: string;
}

export interface PlaylistWithItems {
  playlist: PlaylistSummary;
  items: PlaylistItemSummary[];
}

export interface PlaylistItemInput {
  title: string;
  url: string;
  durationSec?: number | null;
  thumbnailUrl?: string | null;
}

export async function getGuildSettings(guildId: string): Promise<GuildSettings> {
  const rows = await db
    .select()
    .from(guildSettingsTable)
    .where(eq(guildSettingsTable.guildId, guildId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return {
      guildId,
      djRoleId: null,
      defaultVolume: 100,
      maxQueueLength: 100,
      allowedChannelIds: [],
    };
  }

  return {
    guildId: row.guildId,
    djRoleId: row.djRoleId ?? null,
    defaultVolume: row.defaultVolume,
    maxQueueLength: row.maxQueueLength,
    allowedChannelIds: row.allowedChannelIds ?? [],
  };
}

export async function getPlaylistWithItems(
  playlistId: string,
  guildId?: string,
): Promise<PlaylistWithItems | null> {
  const where = guildId
    ? and(eq(playlistTable.id, playlistId), eq(playlistTable.guildId, guildId))
    : eq(playlistTable.id, playlistId);

  const rows = await db
    .select({ playlist: playlistTable, item: playlistItemTable })
    .from(playlistTable)
    .leftJoin(playlistItemTable, eq(playlistItemTable.playlistId, playlistTable.id))
    .where(where)
    .orderBy(asc(playlistItemTable.position));

  const first = rows[0];
  if (!first) return null;

  const items = rows
    .map((row) => row.item)
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .map((item) => ({
      id: item.id,
      position: item.position,
      title: item.title,
      url: item.url,
      durationSec: item.durationSec ?? null,
      thumbnailUrl: item.thumbnailUrl ?? null,
      addedBy: item.addedBy,
    }));

  return {
    playlist: {
      id: first.playlist.id,
      name: first.playlist.name,
      ownerDiscordId: first.playlist.ownerDiscordId,
      isShared: first.playlist.isShared,
    },
    items,
  };
}

export async function getPlaylistByName(
  guildId: string,
  name: string,
): Promise<PlaylistSummary | null> {
  const rows = await db
    .select()
    .from(playlistTable)
    .where(and(eq(playlistTable.guildId, guildId), eq(playlistTable.name, name)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    ownerDiscordId: row.ownerDiscordId,
    isShared: row.isShared,
  };
}

export async function listPlaylists(guildId: string): Promise<PlaylistSummary[]> {
  const rows = await db
    .select()
    .from(playlistTable)
    .where(eq(playlistTable.guildId, guildId))
    .orderBy(asc(playlistTable.name));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    ownerDiscordId: row.ownerDiscordId,
    isShared: row.isShared,
  }));
}

/**
 * Bot write exception (documented in the implementation report): the web app owns
 * playlist writes, but `/playlist save` must work without a round trip through the
 * web process, so the bot inserts the playlist and its items directly.
 */
export async function createPlaylistWithItems(input: {
  guildId: string;
  ownerDiscordId: string;
  name: string;
  items: PlaylistItemInput[];
}): Promise<string> {
  const playlistId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(playlistTable).values({
      id: playlistId,
      guildId: input.guildId,
      ownerDiscordId: input.ownerDiscordId,
      name: input.name,
    });

    if (input.items.length > 0) {
      await tx.insert(playlistItemTable).values(
        input.items.map((item, index) => ({
          id: randomUUID(),
          playlistId,
          position: index,
          title: item.title,
          url: item.url,
          durationSec: item.durationSec ?? null,
          thumbnailUrl: item.thumbnailUrl ?? null,
          addedBy: input.ownerDiscordId,
        })),
      );
    }
  });
  return playlistId;
}

/** Second bot write exception: `/playlist delete` needs to remove the row. */
export async function deletePlaylistByName(guildId: string, name: string): Promise<boolean> {
  const rows = await db
    .delete(playlistTable)
    .where(and(eq(playlistTable.guildId, guildId), eq(playlistTable.name, name)))
    .returning({ id: playlistTable.id });
  return rows.length > 0;
}

export async function recordPlay(input: {
  guildId: string;
  title: string;
  url: string;
  durationSec: number | null;
  requestedBy: string;
}): Promise<void> {
  await db.insert(playHistoryTable).values({
    id: randomUUID(),
    guildId: input.guildId,
    title: input.title,
    url: input.url,
    durationSec: input.durationSec,
    requestedBy: input.requestedBy,
  });
}

export type PlayHistoryRecord = InferSelectModel<typeof playHistoryTable>;

export async function listPlayHistory(
  guildId: string,
  limit: number,
  offset: number,
): Promise<PlayHistoryRecord[]> {
  return db
    .select()
    .from(playHistoryTable)
    .where(eq(playHistoryTable.guildId, guildId))
    .orderBy(desc(playHistoryTable.playedAt))
    .limit(Math.max(1, Math.min(100, limit)))
    .offset(Math.max(0, offset));
}

export async function countPlayHistory(guildId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(playHistoryTable)
    .where(eq(playHistoryTable.guildId, guildId));
  return Number(rows[0]?.value ?? 0);
}
