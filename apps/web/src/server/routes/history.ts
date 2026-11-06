import { playHistory as playHistoryTable } from "@music/shared";
import { desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { success, validationFailure } from "../envelope.js";
import type { AppEnv } from "../types.js";

export const historyRoutes = new Hono<AppEnv>();

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

historyRoutes.get("/guilds/:guildId/history", async (c) => {
  const parsed = historyQuerySchema.safeParse({
    limit: c.req.query("limit"),
    offset: c.req.query("offset"),
  });
  if (!parsed.success) return c.json(validationFailure(parsed.error), 400);

  const { limit, offset } = parsed.data;
  const guildId = c.req.param("guildId");

  const [items, totals] = await Promise.all([
    db
      .select()
      .from(playHistoryTable)
      .where(eq(playHistoryTable.guildId, guildId))
      .orderBy(desc(playHistoryTable.playedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(playHistoryTable)
      .where(eq(playHistoryTable.guildId, guildId)),
  ]);

  return c.json(success({ items, total: totals[0]?.total ?? 0 }), 200);
});
