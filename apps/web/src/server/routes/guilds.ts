import { controlActionSchema } from "@music/shared";
import { Hono } from "hono";
import { botClient, botErrorStatus } from "../bot-client.js";
import { failure, readJsonBody, success, validationFailure } from "../envelope.js";
import { withRequestedByActor } from "../lib.js";
import type { AppEnv } from "../types.js";

export const guildRoutes = new Hono<AppEnv>();

guildRoutes.get("/guilds", async (c) => {
  const result = await botClient.guilds();
  if (!result.ok)
    return c.json(
      failure(result.error.code, result.error.message),
      botErrorStatus(result.error.code),
    );
  return c.json(success(result.data));
});

guildRoutes.get("/guilds/:guildId/state", async (c) => {
  const result = await botClient.state(c.req.param("guildId"));
  if (!result.ok)
    return c.json(
      failure(result.error.code, result.error.message),
      botErrorStatus(result.error.code),
    );
  return c.json(success(result.data));
});

guildRoutes.post("/guilds/:guildId/actions", async (c) => {
  const body = await readJsonBody(c.req.raw);
  const session = c.get("session");

  // The dashboard omits `requestedBy` for playback actions; attribute them to
  // the authenticated admin before validating against the shared union.
  const withActor = withRequestedByActor(body, { id: session.sub, name: session.name });
  const parsed = controlActionSchema.safeParse(withActor);
  if (!parsed.success) return c.json(validationFailure(parsed.error), 400);

  const result = await botClient.action(c.req.param("guildId"), parsed.data);
  if (!result.ok)
    return c.json(
      failure(result.error.code, result.error.message),
      botErrorStatus(result.error.code),
    );
  return c.json(success(result.data));
});
