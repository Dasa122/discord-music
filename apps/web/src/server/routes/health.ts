import { Hono } from "hono";
import { botClient } from "../bot-client.js";

import { sql } from "../db/client.js";
import { failure, success } from "../envelope.js";
import type { AppEnv } from "../types.js";

export const healthRoutes = new Hono<AppEnv>();

async function databaseHealthy(): Promise<boolean> {
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
}

healthRoutes.get("/health", async (c) => {
  const [database, bot] = await Promise.all([databaseHealthy(), botClient.health()]);
  const dependencies = { database, bot };

  if (database && bot) {
    return c.json(success({ status: "ok", dependencies }), 200);
  }
  return c.json(
    failure("UNHEALTHY", "One or more dependencies are unavailable", { details: { dependencies } }),
    503,
  );
});
