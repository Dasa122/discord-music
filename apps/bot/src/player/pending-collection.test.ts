import { describe, expect, test } from "bun:test";
import type { QueueTrack } from "@music/shared";
import {
  canUsePendingCollection,
  PENDING_COLLECTION_MAX_ENTRIES,
  PENDING_COLLECTION_TTL_MS,
  PendingCollectionStore,
} from "./pending-collection.js";

const track: QueueTrack = {
  id: "id",
  title: "Track",
  artist: null,
  url: "https://www.youtube.com/watch?v=vid",
  durationSec: 60,
  thumbnailUrl: null,
  source: "youtube",
  requestedBy: { id: "user", name: "User" },
};

function makeStore(
  options: { now?: () => number; maxEntries?: number; token?: () => string } = {},
) {
  let counter = 0;
  return new PendingCollectionStore({
    now: options.now ?? (() => 0),
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    createToken: options.token ?? (() => `tok-${++counter}`),
  });
}

function input(guildId = "guild") {
  return {
    guildId,
    userId: "user",
    textChannelId: "channel",
    title: "Mix",
    badge: "Spotify",
    tracks: [track],
  };
}

describe("pending collection store", () => {
  test("stores and returns a collection by token", () => {
    const store = makeStore();
    const collection = store.add(input());
    expect(collection.token).toBe("tok-1");
    expect(store.get(collection.token)).toEqual(collection);
    expect(store.size()).toBe(1);
  });

  test("expires after the five-minute TTL", () => {
    let now = 0;
    const store = makeStore({ now: () => now });
    const collection = store.add(input());

    now = PENDING_COLLECTION_TTL_MS - 1;
    expect(store.get(collection.token)).not.toBeNull();

    now = PENDING_COLLECTION_TTL_MS;
    expect(store.get(collection.token)).toBeNull();
    expect(store.size()).toBe(0);
  });

  test("evicts the oldest entry at the cap", () => {
    const store = makeStore({ maxEntries: 2 });
    const first = store.add(input());
    store.add(input());
    const third = store.add(input());

    expect(store.size()).toBe(2);
    expect(store.get(first.token)).toBeNull();
    expect(store.get(third.token)).not.toBeNull();
    expect(PENDING_COLLECTION_MAX_ENTRIES).toBe(20);
  });

  test("unknown tokens are null, never an error", () => {
    const store = makeStore();
    expect(store.get("missing")).toBeNull();
  });

  test("ownership: the requester, or a server manager", () => {
    const store = makeStore();
    const collection = store.add(input());
    expect(canUsePendingCollection(collection, "user")).toBe(true);
    expect(canUsePendingCollection(collection, "someone-else")).toBe(false);
    expect(canUsePendingCollection(collection, "someone-else", true)).toBe(true);
  });

  test("clearGuild drops only that guild's collections", () => {
    const store = makeStore();
    const mine = store.add(input("guild-a"));
    const other = store.add(input("guild-b"));

    expect(store.clearGuild("guild-a")).toBe(1);
    expect(store.get(mine.token)).toBeNull();
    expect(store.get(other.token)).not.toBeNull();
    expect(store.clearGuild("guild-a")).toBe(0);
  });
});
