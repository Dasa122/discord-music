import { describe, expect, test } from "bun:test";
import {
  isPlaylistVisible,
  isSameIdSet,
  newId,
  nextPosition,
  withRequestedByActor,
} from "./lib.js";

describe("newId", () => {
  test("returns 16 URL-safe characters", () => {
    const id = newId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  test("does not repeat", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId()));
    expect(ids.size).toBe(200);
  });
});

describe("isSameIdSet", () => {
  test("accepts an identical order", () => {
    expect(isSameIdSet(["a", "b", "c"], ["a", "b", "c"])).toBe(true);
  });

  test("accepts a permutation", () => {
    expect(isSameIdSet(["a", "b", "c"], ["c", "a", "b"])).toBe(true);
  });

  test("rejects different lengths", () => {
    expect(isSameIdSet(["a", "b"], ["a"])).toBe(false);
    expect(isSameIdSet(["a"], ["a", "b"])).toBe(false);
  });

  test("rejects different members", () => {
    expect(isSameIdSet(["a", "b"], ["a", "c"])).toBe(false);
  });

  test("rejects duplicates on either side", () => {
    expect(isSameIdSet(["a", "a"], ["a", "a"])).toBe(false);
    expect(isSameIdSet(["a", "b"], ["a", "a"])).toBe(false);
  });
});

describe("withRequestedByActor", () => {
  test("attributes play and playPlaylist to the session admin", () => {
    const actor = { id: "user-1", name: "Ada" };
    expect(withRequestedByActor({ type: "play", query: "lofi" }, actor)).toEqual({
      type: "play",
      query: "lofi",
      requestedBy: actor,
    });
    expect(withRequestedByActor({ type: "playPlaylist", playlistId: "p1" }, actor)).toEqual({
      type: "playPlaylist",
      playlistId: "p1",
      requestedBy: actor,
    });
  });

  test("always replaces a client-supplied requestedBy", () => {
    const actor = { id: "user-1", name: "Ada" };
    const body = { type: "play", query: "lofi", requestedBy: { id: "x", name: "X" } };
    expect(withRequestedByActor(body, actor)).toEqual({
      type: "play",
      query: "lofi",
      requestedBy: actor,
    });
    expect(body.requestedBy).toEqual({ id: "x", name: "X" });
  });

  test("leaves non-playback actions and non-objects untouched", () => {
    const pause = { type: "pause" };
    expect(withRequestedByActor(pause, { id: "u", name: "U" })).toBe(pause);
    expect(withRequestedByActor(null, { id: "u", name: "U" })).toBeNull();
    expect(withRequestedByActor("play", { id: "u", name: "U" })).toBe("play");
  });
});

describe("isPlaylistVisible", () => {
  test("owners always see their playlist", () => {
    expect(isPlaylistVisible({ ownerDiscordId: "me", isShared: false }, "me")).toBe(true);
  });

  test("shared playlists are visible to other admins", () => {
    expect(isPlaylistVisible({ ownerDiscordId: "other", isShared: true }, "me")).toBe(true);
  });

  test("private playlists are invisible to other admins", () => {
    expect(isPlaylistVisible({ ownerDiscordId: "other", isShared: false }, "me")).toBe(false);
  });
});

describe("nextPosition", () => {
  test("starts an empty playlist at zero", () => {
    expect(nextPosition(null)).toBe(0);
    expect(nextPosition(undefined)).toBe(0);
  });

  test("appends after the current maximum", () => {
    expect(nextPosition(0)).toBe(1);
    expect(nextPosition(41)).toBe(42);
  });
});
