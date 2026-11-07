import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { MediaError } from "../errors.js";
import { AudioCache } from "./audio-cache.js";
import type { AudioStore } from "./audio-store.js";
import {
  CACHE_PREBUFFER_BYTES,
  type MediaEngineDeps,
  STREAM_PREBUFFER_BYTES,
  YtdlpMediaEngine,
} from "./media-engine.js";

class MemoryStore implements AudioStore {
  readonly objects = new Map<string, number>();
  async put(key: string): Promise<void> {
    this.objects.set(key, 1);
  }
  async playbackTarget(key: string): Promise<string> {
    return `mem://${key}`;
  }
  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        deleted += 1;
      }
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

function pcmStream(bytes: number, end = false): PassThrough {
  const stream = new PassThrough();
  stream.write(Buffer.alloc(bytes));
  if (end) stream.end();
  return stream;
}

function fakeProcess(): ChildProcess {
  return { exitCode: null, kill: () => true } as unknown as ChildProcess;
}

function makeEngine(overrides: {
  cache?: AudioCache;
  deps?: Partial<MediaEngineDeps>;
  prefetchEnabled?: boolean;
}) {
  return new YtdlpMediaEngine({
    ytdlp: { path: "yt-dlp", denoPath: "deno" },
    ffmpegPath: "ffmpeg",
    cache: overrides.cache,
    prefetchEnabled: overrides.prefetchEnabled,
    prebufferTimeoutMs: 500,
    deps: {
      downloadAudio: async () => "/tmp/produced",
      openAudioStream: async () => ({ process: fakeProcess(), stream: pcmStream(200_000) }),
      toPcm: () => pcmStream(200_000),
      toPcmFromFile: () => ({ stream: pcmStream(60_000), kill: () => undefined }),
      ...overrides.deps,
    },
  });
}

function makeCache(store: MemoryStore): AudioCache {
  return new AudioCache({
    store,
    mode: "local",
    maxBytes: 10_000_000,
    prefix: "",
    cacheDir: "/cache",
    tempRoot: "/tmp/music-audio-engine-test",
    statFile: async () => ({ size: 10 }),
  });
}

const track = {
  id: "vid",
  url: "https://www.youtube.com/watch?v=vid",
  title: "Track",
  durationSec: 30,
};

describe("media engine source selection", () => {
  test("a cached track uses ffmpeg on the store target with a 250 ms prebuffer", async () => {
    const store = new MemoryStore();
    const cache = makeCache(store);
    await cache.storeFile("s", "vid", "/tmp/produced");

    let target = "";
    const engine = makeEngine({
      cache,
      deps: {
        toPcmFromFile: (path) => {
          target = path;
          return { stream: pcmStream(CACHE_PREBUFFER_BYTES + 1_000), kill: () => undefined };
        },
      },
    });

    const opened = await engine.open(track, { sessionId: "s" });
    opened.stop();

    expect(opened.source).toBe("cache");
    expect(target).toBe("mem://s/vid.audio");
    expect(CACHE_PREBUFFER_BYTES).toBe(48_000);
    expect(STREAM_PREBUFFER_BYTES).toBe(192_000);
  });

  test("an uncached track streams through yt-dlp", async () => {
    const engine = makeEngine({ cache: makeCache(new MemoryStore()) });
    const opened = await engine.open(track, { sessionId: "s" });
    opened.stop();
    expect(opened.source).toBe("stream");
  });

  test("a live track never uses the cache", async () => {
    const store = new MemoryStore();
    const cache = makeCache(store);
    await cache.storeFile("s", "vid", "/tmp/produced");

    const engine = makeEngine({ cache });
    const opened = await engine.open({ ...track, isLive: true }, { sessionId: "s" });
    opened.stop();
    expect(opened.source).toBe("stream");
  });

  test("a failed download degrades to streaming", async () => {
    const cache = makeCache(new MemoryStore());
    const engine = makeEngine({
      cache,
      deps: {
        downloadAudio: async () => {
          throw new MediaError("DOWNLOAD_FAILED", "nope");
        },
      },
    });

    await engine.prepare(track, "s");
    const opened = await engine.open(track, { sessionId: "s" });
    opened.stop();
    expect(opened.source).toBe("stream");
  });
});

describe("media engine prefetch", () => {
  test("dedupes concurrent requests for the same track", async () => {
    let downloads = 0;
    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      deps: {
        downloadAudio: async () => {
          downloads += 1;
          return "/tmp/produced";
        },
      },
    });

    await Promise.all([engine.prefetch(track, "s"), engine.prefetch(track, "s")]);
    expect(downloads).toBe(1);
  });

  test("cancelPrefetch aborts the in-flight download", async () => {
    let aborted = false;
    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      deps: {
        downloadAudio: (_track, _dir, options) =>
          new Promise<string>((_resolve, reject) => {
            if (options.signal?.aborted) {
              aborted = true;
              reject(new MediaError("DOWNLOAD_ABORTED", "cancelled"));
              return;
            }
            options.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new MediaError("DOWNLOAD_ABORTED", "cancelled"));
            });
          }),
      },
    });

    const run = engine.prefetch(track, "s");
    engine.cancelPrefetch("s");
    await run;
    expect(aborted).toBe(true);
  });

  test("prefetching is skipped when disabled", async () => {
    let downloads = 0;
    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      prefetchEnabled: false,
      deps: {
        downloadAudio: async () => {
          downloads += 1;
          return "/tmp/produced";
        },
      },
    });

    await engine.prefetch(track, "s");
    expect(downloads).toBe(0);
  });
});
