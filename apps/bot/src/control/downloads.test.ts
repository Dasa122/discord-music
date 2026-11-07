import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Client } from "discord.js";

// `config.ts` parses the process environment at import time; give it valid
// placeholders before the modules are evaluated.
process.env.DISCORD_TOKEN ??= "test-discord-token";
process.env.DISCORD_CLIENT_ID ??= "test-client-id";
process.env.BOT_CONTROL_SECRET ??= "test-control-secret-0123456789";
process.env.DATABASE_URL ??= "postgres://postgres:postgres@127.0.0.1:5432/music_test";

const { closeControlServer, createControlServer } = await import("./server.js");
const { initRegistry } = await import("../player/registry.js");
const { config } = await import("../config.js");

const secret = process.env.BOT_CONTROL_SECRET ?? "";
const guildId = "guild-1";

let server: ReturnType<typeof createControlServer>;
let port = 0;

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

beforeAll(async () => {
  const guild = { id: guildId, voiceAdapterCreator: () => undefined };
  const client = {
    guilds: {
      cache: new Map([[guildId, guild]]),
      fetch: async () => guild,
    },
  } as unknown as Client;

  initRegistry({
    client,
    media: {
      resolve: async () => {
        throw new Error("not used");
      },
      resolveSearch: async () => [],
      open: async () => {
        throw new Error("not used");
      },
    },
  });

  server = createControlServer(client);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await closeControlServer(server);
});

describe("GET /guilds/:guildId/downloads", () => {
  test("returns the contract shape with no active session", async () => {
    const response = await fetch(url(`/guilds/${guildId}/downloads`), {
      headers: { "x-control-secret": secret },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessionId: null,
      entries: [],
      totalBytes: 0,
      maxBytes: config.audioCacheMaxBytes,
      store: config.audioStore,
    });
  });

  test("requires the control secret", async () => {
    const response = await fetch(url(`/guilds/${guildId}/downloads`));
    expect(response.status).toBe(401);
  });

  test("is GET-only", async () => {
    const response = await fetch(url(`/guilds/${guildId}/downloads`), {
      method: "POST",
      headers: { "x-control-secret": secret },
    });
    expect(response.status).toBe(405);
  });

  test("404s for a guild the bot is not in", async () => {
    const response = await fetch(url("/guilds/not-a-guild/downloads"), {
      headers: { "x-control-secret": secret },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "GUILD_NOT_FOUND" } });
  });
});
