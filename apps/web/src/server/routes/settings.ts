import {
  type GuildSettings,
  type GuildSettingsUpdate,
  guildSettings as guildSettingsTable,
  guildSettingsUpdateSchema,
} from "@music/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { botClient, botErrorStatus } from "../bot-client.js";
import { db } from "../db/client.js";
import { failure, readJsonBody, success, validationFailure } from "../envelope.js";
import type { AppEnv } from "../types.js";

export const settingsRoutes = new Hono<AppEnv>();

type SettingsRow = typeof guildSettingsTable.$inferSelect;

const DEFAULT_SETTINGS = {
  djRoleId: null,
  defaultVolume: 100,
  maxQueueLength: 100,
  allowedChannelIds: [] as string[],
} as const;

/**
 * Data access for guild settings routes. Injectable so the guild-existence
 * guard can be tested without Postgres. Pass `null` to restore the Drizzle store.
 */
export type SettingsStore = {
  get(guildId: string): Promise<SettingsRow | null>;
  upsert(guildId: string, update: GuildSettingsUpdate): Promise<SettingsRow | null>;
};

const dbSettingsStore: SettingsStore = {
  async get(guildId) {
    const [row] = await db
      .select()
      .from(guildSettingsTable)
      .where(eq(guildSettingsTable.guildId, guildId))
      .limit(1);
    return row ?? null;
  },
  async upsert(guildId, update) {
    const [row] = await db
      .insert(guildSettingsTable)
      .values({ guildId, ...update })
      .onConflictDoUpdate({
        target: guildSettingsTable.guildId,
        set: { ...update, updatedAt: new Date() },
      })
      .returning();
    return row ?? null;
  },
};

let store: SettingsStore = dbSettingsStore;

/** Swap the persistence layer (tests use an in-memory store). Pass null to restore. */
export function setSettingsStore(next: SettingsStore | null): void {
  store = next ?? dbSettingsStore;
}

function toSettings(row: SettingsRow): GuildSettings {
  return {
    guildId: row.guildId,
    djRoleId: row.djRoleId,
    defaultVolume: row.defaultVolume,
    maxQueueLength: row.maxQueueLength,
    allowedChannelIds: row.allowedChannelIds,
  };
}

/** The bot's guild list is the authority on which guilds the bot can control. */
export function guildExists(guilds: ReadonlyArray<{ id: string }>, guildId: string): boolean {
  return guilds.some((guild) => guild.id === guildId);
}

settingsRoutes.get("/guilds/:guildId/settings", async (c) => {
  const guildId = c.req.param("guildId");
  const row = await store.get(guildId);

  if (!row) return c.json(success({ guildId, ...DEFAULT_SETTINGS }), 200);
  return c.json(success(toSettings(row)), 200);
});

settingsRoutes.put("/guilds/:guildId/settings", async (c) => {
  const guildId = c.req.param("guildId");
  const parsed = guildSettingsUpdateSchema.safeParse(await readJsonBody(c.req.raw));
  if (!parsed.success) return c.json(validationFailure(parsed.error), 400);

  const guilds = await botClient.guilds();
  if (!guilds.ok) {
    return c.json(
      failure(guilds.error.code, guilds.error.message),
      botErrorStatus(guilds.error.code),
    );
  }
  if (!guildExists(guilds.data, guildId)) {
    return c.json(failure("GUILD_NOT_FOUND", "The bot is not in that guild"), 404);
  }

  const row = await store.upsert(guildId, parsed.data);
  if (!row) return c.json(success({ guildId, ...DEFAULT_SETTINGS }), 200);
  return c.json(success(toSettings(row)), 200);
});
