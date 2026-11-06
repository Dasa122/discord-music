import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { GuildSettingsUpdate, GuildSummary } from "@music/shared";
import { Hono } from "hono";
import { installTestEnv } from "../test-env.js";
import type { AppEnv } from "../types.js";
import type { SettingsStore } from "./settings.js";

installTestEnv();

const { setSettingsStore, settingsRoutes } = await import("./settings.js");
const { botClient } = await import("../bot-client.js");

const GUILD: GuildSummary = {
  id: "g1",
  name: "Test Guild",
  iconUrl: null,
  memberCount: 3,
  connected: false,
  playing: false,
  currentTitle: null,
};

type SettingsRow = Awaited<ReturnType<SettingsStore["get"]>>;

function createMemoryStore(): SettingsStore & { rows: Map<string, NonNullable<SettingsRow>> } {
  const rows = new Map<string, NonNullable<SettingsRow>>();
  return {
    rows,
    async get(guildId) {
      return rows.get(guildId) ?? null;
    },
    async upsert(guildId, update: GuildSettingsUpdate) {
      const previous = rows.get(guildId);
      const row = {
        guildId,
        djRoleId: update.djRoleId ?? previous?.djRoleId ?? null,
        defaultVolume: update.defaultVolume ?? previous?.defaultVolume ?? 100,
        maxQueueLength: update.maxQueueLength ?? previous?.maxQueueLength ?? 100,
        allowedChannelIds: update.allowedChannelIds ?? previous?.allowedChannelIds ?? [],
        createdAt: previous?.createdAt ?? new Date("2026-11-06T12:00:00.000Z"),
        updatedAt: new Date("2026-11-06T12:00:00.000Z"),
      };
      rows.set(guildId, row);
      return row;
    },
  };
}

function makeApp(store: SettingsStore) {
  setSettingsStore(store);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("session", {
      id: "session-1",
      sub: "admin",
      name: "Admin",
      groups: ["music-admins"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    await next();
  });
  app.route("/api", settingsRoutes);
  return app;
}

function putBody(body: unknown): RequestInit {
  return {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

afterEach(() => {
  setSettingsStore(null);
});

describe("PUT guild settings guild guard", () => {
  test("404 GUILD_NOT_FOUND for a guild the bot is not in", async () => {
    const store = createMemoryStore();
    const guilds = spyOn(botClient, "guilds").mockResolvedValue({ ok: true, data: [GUILD] });

    try {
      const response = await makeApp(store).request(
        "/api/guilds/g2/settings",
        putBody({ defaultVolume: 120 }),
      );

      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("GUILD_NOT_FOUND");
      expect(store.rows.has("g2")).toBe(false);
    } finally {
      guilds.mockRestore();
    }
  });

  test("upserts for a known guild", async () => {
    const store = createMemoryStore();
    const guilds = spyOn(botClient, "guilds").mockResolvedValue({ ok: true, data: [GUILD] });

    try {
      const response = await makeApp(store).request(
        "/api/guilds/g1/settings",
        putBody({ defaultVolume: 120 }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: { defaultVolume: number } };
      expect(body.data.defaultVolume).toBe(120);
      expect(store.rows.has("g1")).toBe(true);
    } finally {
      guilds.mockRestore();
    }
  });

  test("propagates bot unavailability instead of writing", async () => {
    const store = createMemoryStore();
    const guilds = spyOn(botClient, "guilds").mockResolvedValue({
      ok: false,
      error: { code: "BOT_UNAVAILABLE", message: "down" },
    });

    try {
      const response = await makeApp(store).request(
        "/api/guilds/g1/settings",
        putBody({ defaultVolume: 120 }),
      );

      expect(response.status).toBe(503);
      expect(store.rows.size).toBe(0);
    } finally {
      guilds.mockRestore();
    }
  });
});
