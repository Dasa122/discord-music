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
import { isPlaylistVisible, isSameIdSet, newId, nextPosition } from "../lib.js";
import type { AppEnv } from "../types.js";

export const playlistRoutes = new Hono<AppEnv>();

const itemCountExpression = sql<number>`count(${playlistItemTable.id})::int`;

const updatePlaylistBodySchema = updatePlaylistSchema.extend({
  guildId: z.string().min(1),
});

const insertItemBodySchema = insertPlaylistItemSchema
  .omit({ playlistId: true })
  .extend({ guildId: z.string().min(1), addedBy: z.string().min(1).optional() });

const reorderBodySchema = z.object({
  guildId: z.string().min(1),
  itemIds: z.array(z.string().min(1)).min(1),
});

type PlaylistRow = typeof playlistTable.$inferSelect;
type PlaylistItemRow = typeof playlistItemTable.$inferSelect;
type PlaylistSummaryRow = PlaylistRow & { itemCount: number };

/**
 * Data access for playlist routes.
 *
 * Injectable so route behaviour (guild binding, visibility, conflict mapping)
 * can be tested without Postgres. Pass `null` to restore the Drizzle store.
 */
export type PlaylistStore = {
  listForGuild(guildId: string): Promise<PlaylistSummaryRow[]>;
  create(values: {
    id: string;
    guildId: string;
    ownerDiscordId: string;
    name: string;
    isShared: boolean;
  }): Promise<PlaylistRow | null>;
  findById(playlistId: string): Promise<PlaylistRow | null>;
  update(
    playlistId: string,
    changes: { name?: string; isShared?: boolean; updatedAt: Date },
  ): Promise<PlaylistRow | null>;
  remove(playlistId: string): Promise<void>;
  listItems(playlistId: string): Promise<PlaylistItemRow[]>;
  findItem(playlistId: string, itemId: string): Promise<{ id: string } | null>;
  removeItem(itemId: string): Promise<void>;
  appendItem(values: {
    id: string;
    playlistId: string;
    title: string;
    url: string;
    durationSec: number | null;
    thumbnailUrl: string | null;
    addedBy: string;
  }): Promise<PlaylistItemRow | null>;
  listItemIds(playlistId: string): Promise<string[]>;
  reorder(playlistId: string, itemIds: string[]): Promise<void>;
};

const dbPlaylistStore: PlaylistStore = {
  async listForGuild(guildId) {
    return db
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
      .where(eq(playlistTable.guildId, guildId))
      .groupBy(playlistTable.id)
      .orderBy(desc(playlistTable.createdAt));
  },
  async create(values) {
    const [row] = await db.insert(playlistTable).values(values).returning();
    return row ?? null;
  },
  async findById(playlistId) {
    const [row] = await db
      .select()
      .from(playlistTable)
      .where(eq(playlistTable.id, playlistId))
      .limit(1);
    return row ?? null;
  },
  async update(playlistId, changes) {
    const [row] = await db
      .update(playlistTable)
      .set(changes)
      .where(eq(playlistTable.id, playlistId))
      .returning();
    return row ?? null;
  },
  async remove(playlistId) {
    await db.delete(playlistTable).where(eq(playlistTable.id, playlistId));
  },
  async listItems(playlistId) {
    return db
      .select()
      .from(playlistItemTable)
      .where(eq(playlistItemTable.playlistId, playlistId))
      .orderBy(asc(playlistItemTable.position), asc(playlistItemTable.createdAt));
  },
  async findItem(playlistId, itemId) {
    const [row] = await db
      .select({ id: playlistItemTable.id })
      .from(playlistItemTable)
      .where(and(eq(playlistItemTable.id, itemId), eq(playlistItemTable.playlistId, playlistId)))
      .limit(1);
    return row ?? null;
  },
  async removeItem(itemId) {
    await db.delete(playlistItemTable).where(eq(playlistItemTable.id, itemId));
  },
  async appendItem(values) {
    return db.transaction(async (tx) => {
      // Serialise appends for this playlist so max(position) cannot be read by
      // two transactions at once.
      const [locked] = await tx
        .select({ id: playlistTable.id })
        .from(playlistTable)
        .where(eq(playlistTable.id, values.playlistId))
        .for("update");
      if (!locked) return null;

      const [maxRow] = await tx
        .select({ max: sql<number | null>`max(${playlistItemTable.position})` })
        .from(playlistItemTable)
        .where(eq(playlistItemTable.playlistId, values.playlistId));

      const [row] = await tx
        .insert(playlistItemTable)
        .values({ ...values, position: nextPosition(maxRow?.max) })
        .returning();
      return row ?? null;
    });
  },
  async listItemIds(playlistId) {
    const rows = await db
      .select({ id: playlistItemTable.id })
      .from(playlistItemTable)
      .where(eq(playlistItemTable.playlistId, playlistId));
    return rows.map((row) => row.id);
  },
  async reorder(playlistId, itemIds) {
    await db.transaction(async (tx) => {
      for (const [position, itemId] of itemIds.entries()) {
        await tx
          .update(playlistItemTable)
          .set({ position })
          .where(
            and(eq(playlistItemTable.id, itemId), eq(playlistItemTable.playlistId, playlistId)),
          );
      }
    });
  },
};

let store: PlaylistStore = dbPlaylistStore;

/** Swap the persistence layer (tests use an in-memory store). Pass null to restore. */
export function setPlaylistStore(next: PlaylistStore | null): void {
  store = next ?? dbPlaylistStore;
}

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

function guildIdIssue(): ReturnType<typeof failure> {
  return failure("VALIDATION_ERROR", "Request validation failed", {
    issues: [{ path: "guildId", message: "guildId is required" }],
  });
}

function queryGuildId(c: { req: { query: (name: string) => string | undefined } }): string | null {
  const value = c.req.query("guildId");
  return value !== undefined && value.trim() !== "" ? value : null;
}

/**
 * Playlist ids are enumerable, so a guild mismatch is reported as missing
 * rather than forbidden.
 */
function belongsToGuild(row: PlaylistRow, guildId: string): boolean {
  return row.guildId === guildId;
}

playlistRoutes.get("/guilds/:guildId/playlists", async (c) => {
  const session = c.get("session");
  const rows = await store.listForGuild(c.req.param("guildId"));

  const visible = rows.filter((row) => isPlaylistVisible(row, session.sub));
  return c.json(success(visible), 200);
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
    const row = await store.create({
      id: newId(),
      guildId,
      ownerDiscordId: session.sub,
      name: parsed.data.name,
      isShared: parsed.data.isShared ?? false,
    });

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

  const existing = await store.findById(playlistId);
  if (!existing || !belongsToGuild(existing, parsed.data.guildId)) {
    return c.json(notFoundFailure(), 404);
  }

  const changes: { name?: string; isShared?: boolean; updatedAt: Date } = { updatedAt: new Date() };
  if (parsed.data.name !== undefined) changes.name = parsed.data.name;
  if (parsed.data.isShared !== undefined) changes.isShared = parsed.data.isShared;

  try {
    const row = await store.update(playlistId, changes);
    if (!row) return c.json(notFoundFailure(), 404);
    return c.json(success(playlistDetailDto(row, await store.listItems(playlistId))), 200);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return c.json(failure("PLAYLIST_EXISTS", "A playlist with that name already exists"), 409);
    }
    throw error;
  }
});

playlistRoutes.delete("/playlists/:playlistId", async (c) => {
  const playlistId = c.req.param("playlistId");
  const guildId = queryGuildId(c);
  if (!guildId) return c.json(guildIdIssue(), 400);

  const existing = await store.findById(playlistId);
  if (!existing || !belongsToGuild(existing, guildId)) {
    return c.json(notFoundFailure(), 404);
  }

  await store.remove(playlistId);
  return c.json(success(null), 200);
});

playlistRoutes.get("/playlists/:playlistId", async (c) => {
  const playlistId = c.req.param("playlistId");
  const guildId = queryGuildId(c);
  if (!guildId) return c.json(guildIdIssue(), 400);

  const playlist = await store.findById(playlistId);
  if (!playlist || !belongsToGuild(playlist, guildId)) {
    return c.json(notFoundFailure(), 404);
  }
  if (!isPlaylistVisible(playlist, c.get("session").sub)) {
    return c.json(notFoundFailure(), 404);
  }

  return c.json(success(playlistDetailDto(playlist, await store.listItems(playlistId))), 200);
});

playlistRoutes.post("/playlists/:playlistId/items", async (c) => {
  const playlistId = c.req.param("playlistId");
  const parsed = insertItemBodySchema.safeParse(await readJsonBody(c.req.raw));
  if (!parsed.success) return c.json(validationFailure(parsed.error), 400);

  const playlist = await store.findById(playlistId);
  if (!playlist || !belongsToGuild(playlist, parsed.data.guildId)) {
    return c.json(notFoundFailure("Playlist not found"), 404);
  }

  const item = await store.appendItem({
    id: newId(),
    playlistId,
    title: parsed.data.title,
    url: parsed.data.url,
    durationSec: parsed.data.durationSec ?? null,
    thumbnailUrl: parsed.data.thumbnailUrl ?? null,
    addedBy: parsed.data.addedBy ?? c.get("session").sub,
  });

  if (!item) return c.json(notFoundFailure("Playlist not found"), 404);
  return c.json(success(item), 201);
});

playlistRoutes.delete("/playlists/:playlistId/items/:itemId", async (c) => {
  const playlistId = c.req.param("playlistId");
  const itemId = c.req.param("itemId");
  const guildId = queryGuildId(c);
  if (!guildId) return c.json(guildIdIssue(), 400);

  const playlist = await store.findById(playlistId);
  if (!playlist || !belongsToGuild(playlist, guildId)) {
    return c.json(notFoundFailure("Playlist not found"), 404);
  }

  const item = await store.findItem(playlistId, itemId);
  if (!item) return c.json(notFoundFailure("Playlist item not found"), 404);

  await store.removeItem(itemId);
  return c.json(success(null), 200);
});

playlistRoutes.post("/playlists/:playlistId/reorder", async (c) => {
  const playlistId = c.req.param("playlistId");
  const parsed = reorderBodySchema.safeParse(await readJsonBody(c.req.raw));
  if (!parsed.success) return c.json(validationFailure(parsed.error), 400);

  const playlist = await store.findById(playlistId);
  if (!playlist || !belongsToGuild(playlist, parsed.data.guildId)) {
    return c.json(notFoundFailure("Playlist not found"), 404);
  }

  const currentIds = await store.listItemIds(playlistId);
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

  await store.reorder(playlistId, parsed.data.itemIds);

  return c.json(success(playlistDetailDto(playlist, await store.listItems(playlistId))), 200);
});
