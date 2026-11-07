import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { DownloadsResponse } from "@music/shared";
import { downloadsResponseSchema } from "@music/shared";
import { Hono } from "hono";
import { installTestEnv } from "../test-env.js";
import type { AppEnv } from "../types.js";

installTestEnv();

const { botClient } = await import("../bot-client.js");
const { guildRoutes } = await import("./guilds.js");

const PAYLOAD: DownloadsResponse = {
  sessionId: "session-1",
  entries: [
    {
      trackId: "track-1",
      title: "A song",
      state: "downloading",
      bytes: 1_200,
      totalBytes: 4_800,
      percent: 25,
      startedAt: "2026-11-07T12:00:00.000Z",
      finishedAt: null,
      gainDb: 2.4,
      error: null,
    },
  ],
  totalBytes: 1_200,
  maxBytes: 100_000,
  store: "s3",
};

function makeApp() {
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
  app.route("/api", guildRoutes);
  return app;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GET /api/guilds/:guildId/downloads", () => {
  test("proxies the bot payload in a success envelope", async () => {
    const downloads = spyOn(botClient, "downloads").mockResolvedValue({ ok: true, data: PAYLOAD });

    try {
      const response = await makeApp().request("/api/guilds/g1/downloads");

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        success: boolean;
        data: DownloadsResponse;
      };
      expect(body.success).toBe(true);
      expect(body.data).toEqual(PAYLOAD);
    } finally {
      downloads.mockRestore();
    }
  });

  test("maps an unreachable bot to 503 BOT_UNAVAILABLE", async () => {
    const downloads = spyOn(botClient, "downloads").mockResolvedValue({
      ok: false,
      error: { code: "BOT_UNAVAILABLE", message: "down" },
    });

    try {
      const response = await makeApp().request("/api/guilds/g1/downloads");

      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("BOT_UNAVAILABLE");
    } finally {
      downloads.mockRestore();
    }
  });

  test("maps an unknown guild to 404 GUILD_NOT_FOUND", async () => {
    const downloads = spyOn(botClient, "downloads").mockResolvedValue({
      ok: false,
      error: { code: "GUILD_NOT_FOUND", message: "no such guild" },
    });

    try {
      const response = await makeApp().request("/api/guilds/g1/downloads");

      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("GUILD_NOT_FOUND");
    } finally {
      downloads.mockRestore();
    }
  });
});

describe("downloadsResponseSchema", () => {
  test("accepts a valid payload", () => {
    expect(downloadsResponseSchema.safeParse(PAYLOAD).success).toBe(true);
  });

  test("rejects an entry with percent above 100", () => {
    const malformed = {
      ...PAYLOAD,
      entries: [{ ...PAYLOAD.entries[0], percent: 101 }],
    };
    expect(downloadsResponseSchema.safeParse(malformed).success).toBe(false);
  });

  test("rejects a negative byte count", () => {
    const malformed = {
      ...PAYLOAD,
      entries: [{ ...PAYLOAD.entries[0], bytes: -1 }],
    };
    expect(downloadsResponseSchema.safeParse(malformed).success).toBe(false);
  });
});

describe("botClient.downloads", () => {
  test("rejects a malformed bot response instead of proxying it", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ...PAYLOAD, entries: [{ ...PAYLOAD.entries[0], percent: 101 }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await botClient.downloads("g1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BOT_ERROR");
    }
  });
});
