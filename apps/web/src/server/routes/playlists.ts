import {
  createPlaylistSchema,
  insertPlaylistItemSchema,
  playlistItem as playlistItemTable,
  playlist as playlistTable,
  updatePlaylistSchema,
} from "@music/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { isUniqueViolation } from "../db/errors.js";
import { failure, notFoundFailure, readJsonBody, success, validationFailure } from "../envelope.js";
import { isSameIdSet, newId } from "../lib.js";
import type { AppEnv } from "../types.js";

export const playlistRoutes = new Hono<AppEnv>();

const itemCountExpression = sql<number>`count(${playlistItemTable.id})::int`;

const updatePlaylistBodySchema = updatePlaylistSchema.extend({
  guildId: z.string().min(1).optional(),
});

const insertItemBodySchema = insertPlaylistItemSchema
  .omit({ playlistId: true })
  .extend({ addedBy: z.string().min(1).optional() });

const reorderBodySchema = z.object({ itemIds: z.array(z.string().min(1)).min(1) });

type PlaylistRow = typeof playlistTable.$inferSelect;
type PlaylistItemRow = typeof playlistItemTable.$inferSelect;

function playlistDto(row: PlaylistRow, itemCount: number) {
  return {
    id: row.id,
    guildId: row.guildId,
    ownerDiscordId: row.ownerDiscordId,
    name: row.name,
    isShared: row.isShared,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    itemCount,
  };
}

function playlistDetailDto(row: PlaylistRow, items: PlaylistItemRow[]) {
  return { ...playlistDto(row, items.length), items };
}

async function loadPlaylist(playlistId: string): Promise<PlaylistRow | null> {
  const [row] = await db
    .select()
    .from(playlistTable)
    .where(eq(playlistTable.id, playlistId))
    .limit(1);
  return row ?? null;
}

async function loadPlaylistItems(playlistId: string): Promise<PlaylistItemRow[]> {
  return db
    .select()
    .from(playlistItemTable)
    .where(eq(playlistItemTable.playlistId, playlistId))
    .orderBy(asc(playlistItemTable.position), asc(playlistItemTable.createdAt));
}

playlistRoutes.get("/guilds/:guildId/playlists", async (c) => {
  const rows = await db
    .select({
      id: playlistTable.id,
      guildId: playlistTable.guildId,
      ownerDiscordId: playlistTable.ownerDiscordId,
      name: playlistTable.name,
      isShared: playlistTable.isShared,
      createdAt: playlistTable.createdAt,
      updatedAt: playlistTable.updatedAt,
      itemCount: itemCountExpression,
    })
    .from(playlistTable)
    .leftJoin(playlistItemTable, eq(playlistItemTable.playlistId, playlistTable.id))
    .where(eq(playlistTable.guildId, c.req.param("guildId")))
    .groupBy(playlistTable.id)
    .orderBy(desc(playlistTable.createdAt));

  return c.json(success(rows), 200);
});

playlistRoutes.post("/guilds/:guildId/playlists", async (c) => {
  const guildId = c.req.param("guildId");
  const parsed = createPlaylistSchema.safeParse(await readJsonBody(c.req.raw));
  if (!parsed.success) return c.json(validationFailure(parsed.error), 400);
  if (parsed.data.guildId !== guildId) {
    return c.json(
      failure("VALIDATION_ERROR", "Request validation failed", {
        issues: [{ path: "guildId", message: "guildId must match the guild in the path" }],
      }),
      400,
    );
  }

  const session = c.get("session");
  try {
    const [row] = await db
      .insert(playlistTable)
      .values({
        id: newId(),
        guildId,
        ownerDiscordId: session.sub,
        name: parsed.data.name,
        isShared: parsed.data.isShared ?? false,
      })
      .returning();

    if (!row) throw new Error("Playlist insert returned no row");
    return c.json(success(playlistDto(row, 0)), 201);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return c.json(failure("PLAYLIST_EXISTS", "A playlist with that name already exists"), 409);
    }
    throw error;
  }
});

playlistRoutes.patch("/playlists/:playlistId", async (c) => {
  const playlistId = c.req.param("playlistId");
  const parsed = updatePlaylistBodySchema.safeParse(await readJsonBody(c.req.raw));
  if (!parsed.success) return c.json(validationFailure(parsed.error), 400);

  const guildId = c.req.query("guildId") ?? parsed.data.guildId;

  const existing = await loadPlaylist(playlistId);
  if (!existing) return c.json(notFoundFailure(), 404);
  if (guildId !== undefined && existing.guildId !== guildId) {
    return c.json(failure("FORBIDDEN", "The playlist belongs to a different guild"), 403);
  }

  const changes: { name?: string; isShared?: boolean; updatedAt: Date } = { updatedAt: new Date() };
  if (parsed.data.name !== undefined) changes.name = parsed.data.name;
  if (parsed.data.isShared !== undefined) changes.isShared = parsed.data.isShared;

  const [row] = await db
    .update(playlistTable)
    .set(changes)
    .where(eq(playlistTable.id, playlistId))
    .returning();
  if (!row) return c.json(notFoundFailure(), 404);

  return c.json(success(playlistDetailDto(row, await loadPlaylistItems(playlistId))), 200);
});

playlistRoutes.delete("/playlists/:playlistId", async (c) => {
  const playlistId = c.req.param("playlistId");
  const guildId = c.req.query("guildId");

  const existing = await loadPlaylist(playlistId);
  if (!existing) return c.json(notFoundFailure(), 404);
  if (guildId !== undefined && existing.guildId !== guildId) {
    return c.json(failure("FORBIDDEN", "The playlist belongs to a different guild"), 403);
  }

  await db.delete(playlistTable).where(eq(playlistTable.id, playlistId));
  return c.json(success(null), 200);
});

playlistRoutes.get("/playlists/:playlistId", async (c) => {
  const playlistId = c.req.param("playlistId");

  const playlist = await loadPlaylist(playlistId);
  if (!playlist) return c.json(notFoundFailure(), 404);

  return c.json(success(playlistDetailDto(playlist, await loadPlaylistItems(playlistId))), 200);
});

playlistRoutes.post("/playlists/:playlistId/items", async (c) => {
  const playlistId = c.req.param("playlistId");
  const parsed = insertItemBodySchema.safeParse(await readJsonBody(c.req.raw));
  if (!parsed.success) return c.json(validationFailure(parsed.error), 400);

  const [playlist] = await db
    .select({ id: playlistTable.id })
    .from(playlistTable)
    .where(eq(playlistTable.id, playlistId))
    .limit(1);
  if (!playlist) return c.json(notFoundFailure("Playlist not found"), 404);

  const item = await db.transaction(async (tx) => {
    const [maxRow] = await tx
      .select({ max: sql<number | null>`max(${playlistItemTable.position})` })
      .from(playlistItemTable)
      .where(eq(playlistItemTable.playlistId, playlistId));

    const [row] = await tx
      .insert(playlistItemTable)
      .values({
        id: newId(),
        playlistId,
        position: (maxRow?.max ?? -1) + 1,
        title: parsed.data.title,
        url: parsed.data.url,
        durationSec: parsed.data.durationSec ?? null,
        thumbnailUrl: parsed.data.thumbnailUrl ?? null,
        addedBy: parsed.data.addedBy ?? c.get("session").sub,
      })
      .returning();
    return row;
  });

  if (!item) throw new Error("Playlist item insert returned no row");
  return c.json(success(item), 201);
});

playlistRoutes.delete("/playlists/:playlistId/items/:itemId", async (c) => {
  const playlistId = c.req.param("playlistId");
  const itemId = c.req.param("itemId");

  const [item] = await db
    .select({ id: playlistItemTable.id })
    .from(playlistItemTable)
    .where(and(eq(playlistItemTable.id, itemId), eq(playlistItemTable.playlistId, playlistId)))
    .limit(1);
  if (!item) return c.json(notFoundFailure("Playlist item not found"), 404);

  await db.delete(playlistItemTable).where(eq(playlistItemTable.id, itemId));
  return c.json(success(null), 200);
});

playlistRoutes.post("/playlists/:playlistId/reorder", async (c) => {
  const playlistId = c.req.param("playlistId");
  const parsed = reorderBodySchema.safeParse(await readJsonBody(c.req.raw));
  if (!parsed.success) return c.json(validationFailure(parsed.error), 400);

  const [playlist] = await db
    .select({ id: playlistTable.id })
    .from(playlistTable)
    .where(eq(playlistTable.id, playlistId))
    .limit(1);
  if (!playlist) return c.json(notFoundFailure("Playlist not found"), 404);

  const current = await db
    .select({ id: playlistItemTable.id })
    .from(playlistItemTable)
    .where(eq(playlistItemTable.playlistId, playlistId));
  const currentIds = current.map((row) => row.id);

  if (!isSameIdSet(currentIds, parsed.data.itemIds)) {
    return c.json(
      failure("VALIDATION_ERROR", "Request validation failed", {
        issues: [
          { path: "itemIds", message: "itemIds must contain exactly the playlist's current items" },
        ],
      }),
      400,
    );
  }

  await db.transaction(async (tx) => {
    for (const [position, itemId] of parsed.data.itemIds.entries()) {
      await tx
        .update(playlistItemTable)
        .set({ position })
        .where(and(eq(playlistItemTable.id, itemId), eq(playlistItemTable.playlistId, playlistId)));
    }
  });

  const row = await loadPlaylist(playlistId);
  if (!row) return c.json(notFoundFailure("Playlist not found"), 404);
  return c.json(success(playlistDetailDto(row, await loadPlaylistItems(playlistId))), 200);
});
