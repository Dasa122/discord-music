import {
  type GuildSettings,
  guildSettings as guildSettingsTable,
  guildSettingsUpdateSchema,
} from "@music/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client.js";
import { readJsonBody, success, validationFailure } from "../envelope.js";
import type { AppEnv } from "../types.js";

export const settingsRoutes = new Hono<AppEnv>();

type SettingsRow = typeof guildSettingsTable.$inferSelect;

const DEFAULT_SETTINGS = {
  djRoleId: null,
  defaultVolume: 100,
  maxQueueLength: 100,
  allowedChannelIds: [] as string[],
} as const;

function toSettings(row: SettingsRow): GuildSettings {
  return {
    guildId: row.guildId,
    djRoleId: row.djRoleId,
    defaultVolume: row.defaultVolume,
    maxQueueLength: row.maxQueueLength,
    allowedChannelIds: row.allowedChannelIds,
  };
}

settingsRoutes.get("/guilds/:guildId/settings", async (c) => {
  const guildId = c.req.param("guildId");
  const [row] = await db
    .select()
    .from(guildSettingsTable)
    .where(eq(guildSettingsTable.guildId, guildId))
    .limit(1);

  if (!row) return c.json(success({ guildId, ...DEFAULT_SETTINGS }), 200);
  return c.json(success(toSettings(row)), 200);
});

settingsRoutes.put("/guilds/:guildId/settings", async (c) => {
  const guildId = c.req.param("guildId");
  const parsed = guildSettingsUpdateSchema.safeParse(await readJsonBody(c.req.raw));
  if (!parsed.success) return c.json(validationFailure(parsed.error), 400);

  const update = parsed.data;
  const [row] = await db
    .insert(guildSettingsTable)
    .values({ guildId, ...update })
    .onConflictDoUpdate({
      target: guildSettingsTable.guildId,
      set: { ...update, updatedAt: new Date() },
    })
    .returning();

  if (!row) return c.json(success({ guildId, ...DEFAULT_SETTINGS }), 200);
  return c.json(success(toSettings(row)), 200);
});
