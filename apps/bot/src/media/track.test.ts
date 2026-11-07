import { describe, expect, test } from "bun:test";
import type { QueueTrack } from "@music/shared";
import { enrichTrack, titleLooksUnresolved } from "./track.js";

function track(overrides: Partial<QueueTrack> = {}): QueueTrack {
  return {
    id: "vid",
    title: "A real title",
    url: "https://www.youtube.com/watch?v=vid",
    durationSec: 30,
    thumbnailUrl: null,
    source: "youtube",
    requestedBy: { id: "1", name: "Ada" },
    ...overrides,
  };
}

describe("titleLooksUnresolved", () => {
  test("recognises paste-shaped titles", () => {
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    expect(titleLooksUnresolved("", url)).toBe(true);
    expect(titleLooksUnresolved(url, url)).toBe(true);
    expect(titleLooksUnresolved("https://youtu.be/dQw4w9WgXcQ", url)).toBe(true);
    expect(titleLooksUnresolved("dQw4w9WgXcQ", url)).toBe(true);
  });

  test("accepts a resolved title", () => {
    expect(
      titleLooksUnresolved("Never Gonna Give You Up", "https://www.youtube.com/watch?v=abc"),
    ).toBe(false);
    expect(titleLooksUnresolved("lofi", "https://www.youtube.com/watch?v=abcdefghij")).toBe(false);
  });
});

describe("enrichTrack", () => {
  const info = {
    videoId: "vid",
    title: "Authoritative Title",
    durationSec: 213.5,
    thumbnailUrl: "https://i.ytimg.com/vi/vid/hqdefault.jpg",
  };

  test("does not overwrite a good title", () => {
    const queued = track({ title: "A real title" });
    enrichTrack(queued, info);
    expect(queued.title).toBe("A real title");
  });

  test("replaces a raw id/URL title and fills missing fields", () => {
    const queued = track({
      title: "https://www.youtube.com/watch?v=vid",
      durationSec: null,
      thumbnailUrl: null,
    });

    expect(enrichTrack(queued, info)).toBe(true);
    expect(queued.title).toBe("Authoritative Title");
    expect(queued.durationSec).toBe(214);
    expect(queued.thumbnailUrl).toBe(info.thumbnailUrl);
  });

  test("keeps a known duration", () => {
    const queued = track({ durationSec: 30 });
    enrichTrack(queued, info);
    expect(queued.durationSec).toBe(30);
  });

  test("a null/empty info is a no-op", () => {
    const queued = track({ title: "https://example.com/x", durationSec: null });
    expect(enrichTrack(queued, null)).toBe(false);
    expect(queued.title).toBe("https://example.com/x");
    expect(queued.durationSec).toBeNull();
  });
});
