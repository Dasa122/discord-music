import { describe, expect, test } from "bun:test";
import {
  normalizeResolveKey,
  RESOLVE_CACHE_MAX_ENTRIES,
  RESOLVE_CACHE_TTL_MS,
  ResolveCache,
} from "./resolve-cache.js";
import type { ResolvedTrack } from "./ytdlp.js";

function resolved(overrides: Partial<ResolvedTrack> = {}): ResolvedTrack {
  return {
    videoId: "vid",
    title: "A Song",
    webpageUrl: "https://www.youtube.com/watch?v=vid",
    durationSec: 180,
    thumbnailUrl: "https://i.ytimg.com/vi/vid/hqdefault.jpg",
    isPlaylist: false,
    ...overrides,
  };
}

describe("normalizeResolveKey", () => {
  test("normalises text queries but leaves URLs verbatim", () => {
    expect(normalizeResolveKey("  Some   SONG  ")).toBe("some song");
    expect(normalizeResolveKey("a\t b\nc")).toBe("a b c");

    const url = "https://Example.com/Path/To.mp3?X=One";
    expect(normalizeResolveKey(url)).toBe(url);
    expect(normalizeResolveKey(` ${url} `)).toBe(url);
  });
});

describe("ResolveCache", () => {
  test("miss then hit", () => {
    const cache = new ResolveCache();
    expect(cache.get("nothing here")).toBeNull();
    expect(cache.stats()).toMatchObject({ hit: false, hits: 0, size: 0 });

    cache.set("nothing here", resolved());
    const hit = cache.get("nothing here");
    expect(hit?.title).toBe("A Song");
    expect(cache.stats()).toMatchObject({ hit: true, hits: 1, size: 1 });
  });

  test("same text query normalises to one entry", () => {
    const cache = new ResolveCache();
    cache.set("  Hello   World ", resolved({ title: "Hello" }));
    expect(cache.get("hello world")?.title).toBe("Hello");
    expect(cache.stats().size).toBe(1);
  });

  test("entries expire after the five minute TTL", () => {
    let now = 1_000;
    const cache = new ResolveCache({ now: () => now });
    expect(RESOLVE_CACHE_TTL_MS).toBe(5 * 60_000);

    cache.set("song", resolved());
    now += RESOLVE_CACHE_TTL_MS - 1;
    expect(cache.get("song")).not.toBeNull();

    now += 1;
    expect(cache.get("song")).toBeNull();
    expect(cache.stats().size).toBe(0);
  });

  test("evicts least-recently-used entries at the cap", () => {
    expect(RESOLVE_CACHE_MAX_ENTRIES).toBe(200);
    const cache = new ResolveCache({ maxEntries: 2 });
    cache.set("one", resolved({ title: "One" }));
    cache.set("two", resolved({ title: "Two" }));

    // Touch "one" so "two" becomes the least recently used.
    expect(cache.get("one")?.title).toBe("One");
    cache.set("three", resolved({ title: "Three" }));

    expect(cache.get("one")?.title).toBe("One");
    expect(cache.get("three")?.title).toBe("Three");
    expect(cache.get("two")).toBeNull();
    expect(cache.stats().size).toBe(2);
  });

  test("keeps a capped map when many keys are stored", () => {
    const cache = new ResolveCache({ maxEntries: 3 });
    for (let index = 0; index < 5; index += 1) {
      cache.set(`key ${index}`, resolved({ title: `Track ${index}` }));
    }
    expect(cache.stats().size).toBe(3);
    expect(cache.get("key 0")).toBeNull();
    expect(cache.get("key 1")).toBeNull();
    expect(cache.get("key 4")?.title).toBe("Track 4");
  });

  test("never stores a googlevideo or signed stream URL", () => {
    const cache = new ResolveCache();
    cache.set("stream", {
      ...resolved(),
      webpageUrl:
        "https://rr1---sn-abc123.googlevideo.com/videoplayback?expire=1&sig=SIGNED&id=vid",
      thumbnailUrl: "https://rr1---sn-abc123.googlevideo.com/thumb.jpg",
      entries: [
        {
          videoId: "child",
          title: "Child",
          webpageUrl: "https://rr2---sn-xyz.googlevideo.com/videoplayback?sig=2",
          durationSec: 10,
          thumbnailUrl: null,
          isPlaylist: false,
        },
      ],
    });

    const stored = cache.get("stream");
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain("googlevideo");
    expect(stored?.thumbnailUrl).toBeNull();
    // Only metadata survives: no session-scoped key, no page/stream URL.
    expect(Object.keys(stored ?? {}).sort()).toEqual(
      ["durationSec", "entries", "isPlaylist", "thumbnailUrl", "title", "videoId"].sort(),
    );
    expect(Object.keys(stored?.entries?.[0] ?? {}).sort()).toEqual(
      ["durationSec", "isPlaylist", "thumbnailUrl", "title", "videoId"].sort(),
    );
  });
});
