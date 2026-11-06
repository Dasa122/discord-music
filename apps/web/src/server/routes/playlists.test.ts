import { describe, expect, test } from "bun:test";
import type { PlaylistItemRow, PlaylistRow } from "@music/shared";
import { Hono } from "hono";
import { installTestEnv } from "../test-env.js";
import type { AppEnv } from "../types.js";
import type { PlaylistStore } from "./playlists.js";

installTestEnv();

const { playlistRoutes, setPlaylistStore } = await import("./playlists.js");

const NOW = new Date("2026-11-06T12:00:00.000Z");

function playlistRow(overrides: Partial<PlaylistRow> = {}): PlaylistRow {
  return {
    id: "p1",
    guildId: "g1",
    ownerDiscordId: "owner",
    name: "Mix",
    isShared: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function itemRow(overrides: Partial<PlaylistItemRow> = {}): PlaylistItemRow {
  return {
    id: "i1",
    playlistId: "p1",
    position: 0,
    title: "Track",
    url: "https://example.test/track",
    durationSec: 60,
    thumbnailUrl: null,
    addedBy: "owner",
    createdAt: NOW,
    ...overrides,
  };
}

type MemoryStore = PlaylistStore & {
  failNextUpdateWithUnique(): void;
  playlists: Map<string, PlaylistRow>;
  items: Map<string, PlaylistItemRow>;
};

function createMemoryStore(
  seed: { playlists?: PlaylistRow[]; items?: PlaylistItemRow[] } = {},
): MemoryStore {
  const playlists = new Map((seed.playlists ?? []).map((row) => [row.id, row]));
  const items = new Map((seed.items ?? []).map((row) => [row.id, row]));
  let uniqueOnNextUpdate = false;

  return {
    playlists,
    items,
    failNextUpdateWithUnique() {
      uniqueOnNextUpdate = true;
    },
    async listForGuild(guildId) {
      return [...playlists.values()]
        .filter((row) => row.guildId === guildId)
        .map((row) => ({
          ...row,
          itemCount: [...items.values()].filter((item) => item.playlistId === row.id).length,
        }));
    },
    async create(values) {
      const row: PlaylistRow = { ...values, createdAt: NOW, updatedAt: NOW };
      playlists.set(row.id, row);
      return row;
    },
    async findById(playlistId) {
      return playlists.get(playlistId) ?? null;
    },
    async update(playlistId, changes) {
      if (uniqueOnNextUpdate) {
        uniqueOnNextUpdate = false;
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      }
      const existing = playlists.get(playlistId);
      if (!existing) return null;
      const next = { ...existing, ...changes };
      playlists.set(playlistId, next);
      return next;
    },
    async remove(playlistId) {
      playlists.delete(playlistId);
    },
    async listItems(playlistId) {
      return [...items.values()]
        .filter((item) => item.playlistId === playlistId)
        .sort((left, right) => left.position - right.position);
    },
    async findItem(playlistId, itemId) {
      const item = items.get(itemId);
      return item && item.playlistId === playlistId ? { id: item.id } : null;
    },
    async removeItem(itemId) {
      items.delete(itemId);
    },
    async appendItem(values) {
      const max = Math.max(
        -1,
        ...[...items.values()]
          .filter((item) => item.playlistId === values.playlistId)
          .map((item) => item.position),
      );
      const row: PlaylistItemRow = {
        ...values,
        position: max + 1,
        createdAt: NOW,
      };
      items.set(row.id, row);
      return row;
    },
    async listItemIds(playlistId) {
      return [...items.values()]
        .filter((item) => item.playlistId === playlistId)
        .sort((left, right) => left.position - right.position)
        .map((item) => item.id);
    },
    async reorder(playlistId, itemIds) {
      itemIds.forEach((itemId, position) => {
        const item = items.get(itemId);
        if (item?.playlistId === playlistId) items.set(itemId, { ...item, position });
      });
    },
  };
}

function makeApp(store: MemoryStore, sub = "owner") {
  setPlaylistStore(store);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("session", {
      id: "session-1",
      sub,
      name: "Admin",
      groups: ["music-admins"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    await next();
  });
  app.route("/api", playlistRoutes);
  return app;
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("playlist guild binding (IDOR)", () => {
  const requests: Array<[string, RequestInit]> = [
    ["/api/playlists/p1?guildId=g2", {}],
    ["/api/playlists/p1", json("PATCH", { guildId: "g2", name: "Renamed" })],
    ["/api/playlists/p1?guildId=g2", { method: "DELETE" }],
    [
      "/api/playlists/p1/items",
      json("POST", { guildId: "g2", title: "Track", url: "https://example.test/t" }),
    ],
    ["/api/playlists/p1/reorder", json("POST", { guildId: "g2", itemIds: ["i1"] })],
    ["/api/playlists/p1/items/i1?guildId=g2", { method: "DELETE" }],
  ];

  for (const [path, init] of requests) {
    test(`${init.method ?? "GET"} ${path} is a 404, not a 403`, async () => {
      const store = createMemoryStore({
        playlists: [playlistRow()],
        items: [itemRow()],
      });
      const response = await makeApp(store).request(path, init);

      expect(response.status).toBe(404);
      const body = (await response.json()) as { success: boolean; error: { code: string } };
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("NOT_FOUND");
    });
  }

  test("a missing guildId is a validation error", async () => {
    const store = createMemoryStore({ playlists: [playlistRow()] });
    const response = await makeApp(store).request("/api/playlists/p1");

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("the matching guild still serves the playlist", async () => {
    const store = createMemoryStore({ playlists: [playlistRow()], items: [itemRow()] });
    const response = await makeApp(store).request("/api/playlists/p1?guildId=g1");

    expect(response.status).toBe(200);
  });
});

describe("playlist visibility", () => {
  test("lists only owned or shared playlists", async () => {
    const store = createMemoryStore({
      playlists: [
        playlistRow({ id: "owned", ownerDiscordId: "owner", isShared: false }),
        playlistRow({ id: "shared", ownerDiscordId: "other", isShared: true }),
        playlistRow({ id: "private", ownerDiscordId: "other", isShared: false }),
      ],
    });

    const response = await makeApp(store).request("/api/guilds/g1/playlists");
    expect(response.status).toBe(200);

    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((row) => row.id)).toEqual(["owned", "shared"]);
  });

  test("detail 404s a private playlist owned by another admin", async () => {
    const store = createMemoryStore({
      playlists: [playlistRow({ ownerDiscordId: "other", isShared: false })],
    });
    const response = await makeApp(store, "someone-else").request("/api/playlists/p1?guildId=g1");
    expect(response.status).toBe(404);
  });

  test("detail serves a shared playlist owned by another admin", async () => {
    const store = createMemoryStore({
      playlists: [playlistRow({ ownerDiscordId: "other", isShared: true })],
    });
    const response = await makeApp(store, "someone-else").request("/api/playlists/p1?guildId=g1");
    expect(response.status).toBe(200);
  });
});

describe("playlist writes", () => {
  test("rename maps a unique violation to 409 PLAYLIST_EXISTS", async () => {
    const store = createMemoryStore({ playlists: [playlistRow()] });
    store.failNextUpdateWithUnique();

    const response = await makeApp(store).request(
      "/api/playlists/p1",
      json("PATCH", { guildId: "g1", name: "Taken" }),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PLAYLIST_EXISTS");
  });

  test("appends items after the current maximum position", async () => {
    const store = createMemoryStore({
      playlists: [playlistRow()],
      items: [itemRow({ id: "i1", position: 0 }), itemRow({ id: "i2", position: 3 })],
    });
    const app = makeApp(store);

    const response = await app.request(
      "/api/playlists/p1/items",
      json("POST", {
        guildId: "g1",
        title: "New track",
        url: "https://example.test/new",
      }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { position: number } };
    expect(body.data.position).toBe(4);
  });
});
