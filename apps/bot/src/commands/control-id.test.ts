import { describe, expect, test } from "bun:test";
import { isControlForCurrentTrack, parseControlId } from "./control-id.js";

describe("parseControlId", () => {
  test("parses an action and track id", () => {
    expect(parseControlId("player:skip:abc123")).toEqual({ action: "skip", trackId: "abc123" });
  });

  test("parses an action without a track id", () => {
    expect(parseControlId("player:queue")).toEqual({ action: "queue", trackId: null });
  });

  test("rejects foreign ids", () => {
    expect(parseControlId("other:skip:abc123")).toBeNull();
    expect(parseControlId("player:")).toBeNull();
  });
});

describe("isControlForCurrentTrack", () => {
  test("a matching track is actionable", () => {
    expect(isControlForCurrentTrack("abc", "abc")).toBe(true);
  });

  test("a different track is stale", () => {
    expect(isControlForCurrentTrack("abc", "def")).toBe(false);
    expect(isControlForCurrentTrack("abc", null)).toBe(false);
  });

  test("controls without a track id are always actionable", () => {
    expect(isControlForCurrentTrack(null, "abc")).toBe(true);
  });
});
