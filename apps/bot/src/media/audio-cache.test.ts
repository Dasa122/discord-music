import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AudioCache,
  audioObjectKey,
  audioRootPrefix,
  audioSessionPrefix,
  audioTempDir,
} from "./audio-cache.js";
import type { AudioStore } from "./audio-store.js";

class MemoryStore implements AudioStore {
  readonly objects = new Map<string, number>();
  readonly putKeys: string[] = [];
  deleteCalls: string[] = [];

  async put(key: string): Promise<void> {
    this.putKeys.push(key);
    this.objects.set(key, 1);
  }

  async playbackTarget(key: string): Promise<string> {
    if (!this.objects.has(key)) throw new Error("missing");
    return `mem://${key}`;
  }

  async deletePrefix(prefix: string): Promise<number> {
    this.deleteCalls.push(prefix);
    let deleted = 0;
    for (const key of [...this.objects.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.objects.delete(key);
      deleted += 1;
    }
    return deleted;
  }

  async listPrefix(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }

  async health(): Promise<boolean> {
    return true;
  }
}

function makeCache(store: MemoryStore, maxBytes = 1_000_000) {
  let clock = 0;
  return new AudioCache({
    store,
    mode: "local",
    maxBytes,
    prefix: "",
    cacheDir: "/cache",
    tempRoot: "/tmp/music-audio-test",
    statFile: async () => ({ size: 10 }),
    now: () => {
      clock += 1;
      return clock;
    },
  });
}

describe("audio key builders", () => {
  test("builds objects under prefix/session and session prefixes", () => {
    expect(audioObjectKey("audio", "sess-1", "abc")).toBe("audio/sess-1/abc.audio");
    expect(audioSessionPrefix("audio", "sess-1")).toBe("audio/sess-1/");
    expect(audioRootPrefix("audio")).toBe("audio/");
    expect(audioObjectKey("", "sess-1", "abc")).toBe("sess-1/abc.audio");
  });

  test("sanitises unsafe track ids", () => {
    expect(audioObjectKey("audio", "s", "https://example.com/a b.mp3")).toBe(
      "audio/s/https___example.com_a_b.mp3.audio",
    );
  });

  test("temp dir depends on the store mode", () => {
    expect(
      audioTempDir({ mode: "local", sessionId: "s", cacheDir: "/data/audio", tempRoot: "/tmp/x" }),
    ).toBe("/data/audio/s");
    expect(
      audioTempDir({ mode: "s3", sessionId: "s", cacheDir: "/data/audio", tempRoot: "/tmp/x" }),
    ).toBe("/tmp/x/s");
  });
});

describe("AudioCache sessions", () => {
  test("store/lookup round-trip and size accounting", async () => {
    const store = new MemoryStore();
    const cache = makeCache(store);

    await cache.storeFile("s1", "a", "/tmp/a");
    expect(cache.has("s1", "a")).toBe(true);
    expect(await cache.size()).toBe(10);
    expect(await cache.target("s1", "a")).toBe("mem://s1/a.audio");
    expect(store.putKeys).toEqual(["s1/a.audio"]);
    expect(store.putKeys.some((key) => key.endsWith(".part"))).toBe(false);
  });

  test("releaseSession deletes only that session's files", async () => {
    const store = new MemoryStore();
    const cache = makeCache(store);

    await cache.claim("s1", "a");
    await cache.storeFile("s1", "a", "/tmp/a");
    await cache.claim("s2", "b");
    await cache.storeFile("s2", "b", "/tmp/b");

    await cache.releaseSession("s1");

    expect(store.objects.has("s1/a.audio")).toBe(false);
    expect(store.objects.has("s2/b.audio")).toBe(true);
    expect(await cache.size()).toBe(10);
  });

  test("a track claimed by two sessions survives until the last release", async () => {
    const store = new MemoryStore();
    const cache = makeCache(store);

    await cache.claim("s1", "shared");
    await cache.storeFile("s1", "shared", "/tmp/a");
    await cache.claim("s2", "shared");
    await cache.storeFile("s2", "shared", "/tmp/b");

    await cache.releaseSession("s1");
    expect(store.objects.has("s2/shared.audio")).toBe(true);

    await cache.releaseSession("s2");
    expect(store.objects.size).toBe(0);
  });

  test("startup wipe removes objects and part leftovers", async () => {
    const store = new MemoryStore();
    store.objects.set("s1/a.audio", 1);
    store.objects.set("s1/a.part", 1);
    const cache = makeCache(store);

    await cache.init();

    expect(store.objects.size).toBe(0);
    expect(await cache.size()).toBe(0);
  });

  test("LRU eviction drops the oldest unpinned object first", async () => {
    const store = new MemoryStore();
    const cache = makeCache(store, 20);

    await cache.storeFile("s1", "a", "/tmp/a");
    await cache.storeFile("s1", "b", "/tmp/b");
    await cache.pin("s1", "b");
    await cache.storeFile("s1", "c", "/tmp/c");

    expect(store.objects.has("s1/a.audio")).toBe(false);
    expect(store.objects.has("s1/b.audio")).toBe(true);
    expect(store.objects.has("s1/c.audio")).toBe(true);
  });

  test("session cleanup calls deletePrefix once and removes the temp dir", async () => {
    const store = new MemoryStore();
    const tempRoot = mkdtempSync(join(tmpdir(), "music-audio-test-"));
    const sessionDir = join(tempRoot, "sess");
    mkdirSync(sessionDir);
    writeFileSync(join(sessionDir, "leftover"), "x");

    const cache = new AudioCache({
      store,
      mode: "s3",
      maxBytes: 1_000_000,
      prefix: "audio",
      cacheDir: "/data/audio",
      tempRoot,
      statFile: async () => ({ size: 10 }),
    });

    await cache.claim("sess", "a");
    await cache.storeFile("sess", "a", "/tmp/a");
    store.deleteCalls = [];

    try {
      await cache.releaseSession("sess");
      expect(store.deleteCalls).toEqual(["audio/sess/"]);
      expect(() => writeFileSync(join(sessionDir, "probe"), "x")).toThrow();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
