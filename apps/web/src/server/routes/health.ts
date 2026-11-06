import { Hono } from "hono";
import { botClient } from "../bot-client.js";

import { sql } from "../db/client.js";
import { failure, success } from "../envelope.js";
import type { AppEnv } from "../types.js";

export const healthRoutes = new Hono<AppEnv>();

export type HealthDependencies = { database: boolean; bot: boolean };

async function databaseHealthy(): Promise<boolean> {
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
}

/** Liveness: the process answers 200 even while a dependency is down. */
export function livenessStatus(_dependencies: HealthDependencies): 200 {
  return 200;
}

/** Readiness: only the database gates traffic; the bot is reported but optional. */
export function readinessStatus(dependencies: HealthDependencies): 200 | 503 {
  return dependencies.database ? 200 : 503;
}

healthRoutes.get("/health", async (c) => {
  const [database, bot] = await Promise.all([databaseHealthy(), botClient.health()]);
  const dependencies: HealthDependencies = { database, bot };

  return c.json(success({ status: "ok", dependencies }), livenessStatus(dependencies));
});

healthRoutes.get("/health/ready", async (c) => {
  const [database, bot] = await Promise.all([databaseHealthy(), botClient.health()]);
  const dependencies: HealthDependencies = { database, bot };
  const status = readinessStatus(dependencies);

  if (status === 200) {
    return c.json(success({ status: "ready", dependencies }), status);
  }
  return c.json(
    failure("NOT_READY", "The database is not reachable", { details: { dependencies } }),
    status,
  );
});
