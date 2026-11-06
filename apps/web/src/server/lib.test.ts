import { describe, expect, test } from "bun:test";
import { isSameIdSet, newId, withRequestedByActor } from "./lib.js";

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

  test("keeps an explicit requestedBy", () => {
    const body = { type: "play", query: "lofi", requestedBy: { id: "x", name: "X" } };
    expect(withRequestedByActor(body, { id: "user-1", name: "Ada" })).toBe(body);
  });

  test("leaves non-playback actions and non-objects untouched", () => {
    const pause = { type: "pause" };
    expect(withRequestedByActor(pause, { id: "u", name: "U" })).toBe(pause);
    expect(withRequestedByActor(null, { id: "u", name: "U" })).toBeNull();
    expect(withRequestedByActor("play", { id: "u", name: "U" })).toBe("play");
  });
});
