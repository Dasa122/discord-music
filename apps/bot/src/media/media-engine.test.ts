import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { MediaError } from "../errors.js";
import { AudioCache } from "./audio-cache.js";
import type { AudioStore } from "./audio-store.js";
import { DownloadRegistry } from "./download-registry.js";
import { buildMeasuredFilter, computeGainDb, type LoudnessSettings } from "./ffmpeg.js";
import {
  CACHE_PREBUFFER_BYTES,
  type MediaEngineDeps,
  STREAM_PREBUFFER_BYTES,
  YtdlpMediaEngine,
} from "./media-engine.js";
import { ResolveCache } from "./resolve-cache.js";
import type { TrackResolver } from "./resolver/types.js";

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
  twoPass?: boolean;
  maxGainDb?: number;
  normalization?: LoudnessSettings;
  streamPrebufferMs?: number;
  resolver?: TrackResolver;
  resolveCache?: ResolveCache;
}) {
  return new YtdlpMediaEngine({
    ytdlp: { path: "yt-dlp", denoPath: "deno" },
    ffmpegPath: "ffmpeg",
    resolver: overrides.resolver,
    resolveCache: overrides.resolveCache,
    cache: overrides.cache,
    normalization: overrides.normalization,
    twoPass: overrides.twoPass,
    maxGainDb: overrides.maxGainDb,
    prefetchEnabled: overrides.prefetchEnabled,
    streamPrebufferMs: overrides.streamPrebufferMs,
    prebufferTimeoutMs: 500,
    deps: {
      downloadAudio: async () => ({ path: "/tmp/produced", info: null }),
      resolve: async () => {
        throw new Error("resolve must not run in this test");
      },
      resolveSearch: async () => [],
      openAudioStream: async () => ({ process: fakeProcess(), stream: pcmStream(200_000) }),
      toPcm: () => pcmStream(200_000),
      toPcmFromFile: () => ({ stream: pcmStream(60_000), kill: () => undefined }),
      analyzeLoudness: async () => null,
      ...overrides.deps,
    },
  });
}

function makeCache(store: MemoryStore, overrides: { cacheDir?: string } = {}): AudioCache {
  return new AudioCache({
    store,
    mode: "local",
    maxBytes: 10_000_000,
    prefix: "",
    cacheDir: overrides.cacheDir ?? "/cache",
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
    expect(STREAM_PREBUFFER_BYTES).toBe(48_000);
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
          return { path: "/tmp/produced", info: null };
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
          new Promise<{ path: string; info: null }>((_resolve, reject) => {
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
          return { path: "/tmp/produced", info: null };
        },
      },
    });

    await engine.prefetch(track, "s");
    expect(downloads).toBe(0);
  });

  test("the registry shows queued immediately, then downloading on the first progress event", async () => {
    const downloads = new DownloadRegistry({ maxBytes: 1_000, store: "local" });
    let progress: ((value: { downloadedBytes: number; totalBytes: number | null }) => void) | null =
      null;
    let finish!: () => void;

    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      deps: {
        downloadAudio: (_track, _dir, options) =>
          new Promise<{ path: string; info: null }>((resolve, reject) => {
            progress = options.onProgress ?? null;
            finish = () => resolve({ path: "/tmp/produced", info: null });
            options.signal?.addEventListener("abort", () =>
              reject(new MediaError("DOWNLOAD_ABORTED", "cancelled")),
            );
          }),
      },
    });

    const run = engine.prefetch(track, "s", downloads);

    // No byte has moved yet, but the dashboard already knows about the job.
    expect(downloads.snapshot().entries[0]?.state).toBe("queued");

    await tick();
    expect(progress).not.toBeNull();
    progress?.({ downloadedBytes: 25, totalBytes: 100 });

    const entry = downloads.snapshot().entries[0];
    expect(entry?.state).toBe("downloading");
    expect(entry?.percent).toBe(25);

    finish();
    await run;
    expect(downloads.snapshot().entries[0]?.state).toBe("ready");
  });

  test("a per-id cancel ends the job as failed instead of ready/downloading", async () => {
    const downloads = new DownloadRegistry({ maxBytes: 1_000, store: "local" });
    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      deps: {
        downloadAudio: (_track, _dir, options) =>
          new Promise<{ path: string; info: null }>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () =>
              reject(new MediaError("DOWNLOAD_ABORTED", "cancelled")),
            );
          }),
      },
    });

    const run = engine.prefetch(track, "s", downloads);
    await tick();
    engine.cancelPrefetch("s", "vid");
    await run;

    const entry = downloads.snapshot().entries[0];
    expect(entry?.state).toBe("failed");
    expect(entry?.error).toBe("ABORTED");
  });
});

async function tick(ms = 15): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("media engine stream-first cache policy", () => {
  test("a not-cached track streams and starts exactly one background cache job", async () => {
    let downloads = 0;
    let release!: (value: { path: string; info: null }) => void;

    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      deps: {
        downloadAudio: () => {
          downloads += 1;
          return new Promise<{ path: string; info: null }>((resolve) => {
            release = resolve;
          });
        },
      },
    });

    const first = await engine.open(track, { sessionId: "s" });
    expect(first.source).toBe("stream");

    // The job is in flight; a second open for the same id must not add one.
    const second = await engine.open(track, { sessionId: "s" });
    expect(second.source).toBe("stream");
    await tick();
    expect(downloads).toBe(1);

    release({ path: "/tmp/produced", info: null });
    await tick();
    first.stop();
    second.stop();
  });

  test("a cached track opens from the cache and starts no download", async () => {
    const store = new MemoryStore();
    const cache = makeCache(store);
    await cache.storeFile("s", "vid", "/tmp/produced");

    let downloads = 0;
    const engine = makeEngine({
      cache,
      deps: {
        downloadAudio: async () => {
          downloads += 1;
          return { path: "/tmp/produced", info: null };
        },
      },
    });

    const opened = await engine.open(track, { sessionId: "s" });
    expect(opened.source).toBe("cache");
    await tick();
    expect(downloads).toBe(0);
    opened.stop();
  });

  test("the background download never replaces or stops the live stream", async () => {
    let release!: (value: { path: string; info: null }) => void;
    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      deps: {
        downloadAudio: () =>
          new Promise<{ path: string; info: null }>((resolve) => {
            release = resolve;
          }),
      },
    });

    const opened = await engine.open(track, { sessionId: "s" });
    const stream = opened.stream;
    const startedAt = Date.now();
    while (typeof release !== "function") {
      if (Date.now() - startedAt > 2_000) throw new Error("background job never started");
      await tick(5);
    }
    let stopped = 0;
    const stop = opened.stop;
    opened.stop = () => {
      stopped += 1;
      stop();
    };

    release({ path: "/tmp/produced", info: null });
    await tick();

    // Same live resource: untouched and still open; the cache is only for later plays.
    expect(opened.stream).toBe(stream);
    expect(stream.destroyed).toBe(false);
    expect(stopped).toBe(0);

    opened.stop();
    expect(stopped).toBe(1);
  });
});

describe("media engine cache-first resolution", () => {
  const videoId = "dQw4w9WgXcQ";
  const cachedTrack = {
    ...track,
    id: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
  const info = {
    videoId,
    title: "Authoritative Title",
    durationSec: 42,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };

  test("a cached YouTube URL resolves from the download metadata without yt-dlp", async () => {
    let ytdlpResolves = 0;
    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      deps: {
        downloadAudio: async () => ({ path: "/tmp/produced", info }),
        resolve: async () => {
          ytdlpResolves += 1;
          throw new Error("yt-dlp must not run for a cached track");
        },
      },
    });

    await engine.prepare(cachedTrack, "s");
    const resolved = await engine.resolve(cachedTrack.url, "s");

    expect(resolved.title).toBe("Authoritative Title");
    expect(resolved.durationSec).toBe(42);
    expect(resolved.thumbnailUrl).toBe(info.thumbnailUrl);
    expect(resolved.videoId).toBe(videoId);
    expect(ytdlpResolves).toBe(0);
  });

  test("search queries still resolve normally", async () => {
    let ytdlpResolves = 0;
    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      deps: {
        resolve: async (query) => {
          ytdlpResolves += 1;
          return {
            videoId: null,
            title: query,
            webpageUrl: "https://example.com/song",
            durationSec: 10,
            thumbnailUrl: null,
            isPlaylist: false,
          };
        },
      },
    });

    const resolved = await engine.resolve("never gonna give you up", "s");
    expect(resolved.title).toBe("never gonna give you up");
    expect(ytdlpResolves).toBe(1);
  });

  test("releasing one session keeps another session's cached metadata", async () => {
    let ytdlpResolves = 0;
    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      deps: {
        downloadAudio: async () => ({ path: "/tmp/produced", info }),
        resolve: async () => {
          ytdlpResolves += 1;
          return {
            videoId: "vid",
            title: "From yt-dlp",
            webpageUrl: track.url,
            durationSec: 1,
            thumbnailUrl: null,
            isPlaylist: false,
          };
        },
      },
    });

    await engine.prepare(cachedTrack, "a");
    await engine.prepare(cachedTrack, "b");
    await engine.releaseSession("a");

    const stillCached = await engine.resolve(cachedTrack.url, "b");
    expect(stillCached.title).toBe("Authoritative Title");
    expect(ytdlpResolves).toBe(0);

    // The released session lost its cache and falls back to the extractor.
    const released = await engine.resolve(cachedTrack.url, "a");
    expect(released.title).toBe("From yt-dlp");
    expect(ytdlpResolves).toBe(1);
  });
});

describe("media engine background cancellation", () => {
  test("endSession aborts the job and leaves no partial file or stored object", async () => {
    const root = mkdtempSync(join(tmpdir(), "music-engine-cancel-"));
    const store = new MemoryStore();
    const cache = makeCache(store, { cacheDir: root });
    const partPath = join(root, "s", "vid.webm.part");

    let aborted = false;
    const engine = makeEngine({
      cache,
      deps: {
        downloadAudio: async (_track, destDir, options) => {
          mkdirSync(destDir, { recursive: true });
          writeFileSync(join(destDir, "vid.webm.part"), "partial");
          return new Promise<{ path: string; info: null }>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new MediaError("DOWNLOAD_ABORTED", "cancelled"));
            });
          });
        },
      },
    });

    try {
      const opened = await engine.open(track, { sessionId: "s" });
      const startedAt = Date.now();
      while (!existsSync(partPath)) {
        if (Date.now() - startedAt > 2_000) throw new Error("background job never started");
        await tick(5);
      }

      await engine.releaseSession("s");

      expect(aborted).toBe(true);
      expect(store.objects.size).toBe(0);
      expect(existsSync(join(root, "s"))).toBe(false);
      opened.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("media engine two-pass gain", () => {
  const measurement = { inputLufs: -23, inputTp: -4, inputLra: 7, inputThresh: -33 };
  const configured = "loudnorm=I=-16:TP=-1.5:LRA=11";

  function captureFileFilter() {
    const captured: { filter: string | null | undefined } = { filter: "unset" };
    return {
      captured,
      toPcmFromFile: (_path: string, options?: { filter?: string | null }) => {
        captured.filter = options?.filter;
        return {
          stream: pcmStream(CACHE_PREBUFFER_BYTES + 1_000),
          kill: () => undefined,
        };
      },
    };
  }

  test("a cached track replays with its measured gain instead of the live filter", async () => {
    const cache = makeCache(new MemoryStore());
    let analyzedPath = "";
    const { captured, toPcmFromFile } = captureFileFilter();

    const engine = makeEngine({
      cache,
      deps: {
        analyzeLoudness: async (path) => {
          analyzedPath = path;
          return measurement;
        },
        toPcmFromFile,
      },
    });

    await engine.ensureCached(track, "s");
    expect(analyzedPath).toBe("/tmp/produced");

    const opened = await engine.open(track, { sessionId: "s" });
    opened.stop();

    expect(opened.source).toBe("cache");
    const gain = computeGainDb(-23, -4, -16, -1.5, 12);
    expect(gain).toBe(2.5);
    expect(captured.filter).toBe(buildMeasuredFilter(gain));
  });

  test("a cached track with no measurement falls back to the configured filter", async () => {
    const { captured, toPcmFromFile } = captureFileFilter();
    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      deps: { toPcmFromFile },
    });

    await engine.ensureCached(track, "s");
    const opened = await engine.open(track, { sessionId: "s" });
    opened.stop();

    expect(opened.source).toBe("cache");
    expect(captured.filter).toBe(configured);
  });

  test("analysis is skipped when two-pass is disabled", async () => {
    let analyses = 0;
    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      twoPass: false,
      deps: {
        analyzeLoudness: async () => {
          analyses += 1;
          return measurement;
        },
      },
    });

    await engine.ensureCached(track, "s");
    expect(analyses).toBe(0);

    const opened = await engine.open(track, { sessionId: "s" });
    opened.stop();
    expect(opened.source).toBe("cache");
  });

  test("a live track is never downloaded or analyzed", async () => {
    let analyses = 0;
    let downloads = 0;
    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      deps: {
        downloadAudio: async () => {
          downloads += 1;
          return { path: "/tmp/produced", info: null };
        },
        analyzeLoudness: async () => {
          analyses += 1;
          return measurement;
        },
      },
    });

    const opened = await engine.open({ ...track, isLive: true }, { sessionId: "s" });
    opened.stop();

    expect(opened.source).toBe("stream");
    expect(downloads).toBe(0);
    expect(analyses).toBe(0);
  });

  test("a failed analysis still caches the track and leaves playback unaffected", async () => {
    const { captured, toPcmFromFile } = captureFileFilter();
    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      deps: {
        analyzeLoudness: async () => {
          throw new Error("ffmpeg exploded");
        },
        toPcmFromFile,
      },
    });

    // The background job must swallow the failure, not reject.
    await engine.ensureCached(track, "s");

    const opened = await engine.open(track, { sessionId: "s" });
    opened.stop();

    expect(opened.source).toBe("cache");
    expect(captured.filter).toBe(configured);
  });

  test("normalization off emits no filter even when a gain was measured", async () => {
    const { captured, toPcmFromFile } = captureFileFilter();
    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      normalization: { mode: "off", targetLufs: -16, truePeakDb: -1.5, lra: 11, dynFrameMs: 150 },
      deps: {
        analyzeLoudness: async () => measurement,
        toPcmFromFile,
      },
    });

    await engine.ensureCached(track, "s");
    const opened = await engine.open(track, { sessionId: "s" });
    opened.stop();

    expect(opened.source).toBe("cache");
    expect(captured.filter).toBeNull();
  });
});

describe("media engine download reporting", () => {
  const measurement = { inputLufs: -23, inputTp: -4, inputLra: 7, inputThresh: -33 };

  function registry() {
    return new DownloadRegistry({ maxBytes: 1_000, store: "local" });
  }

  test("the stream-fill job reports ready with the measured gain", async () => {
    const downloads = registry();
    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      deps: { analyzeLoudness: async () => measurement },
    });

    await engine.ensureCached(track, "s", downloads);

    const snapshot = downloads.snapshot();
    const entry = snapshot.entries[0];
    expect(snapshot.sessionId).toBe("s");
    expect(entry).toMatchObject({
      trackId: "vid",
      title: "Track",
      state: "ready",
      gainDb: 2.5,
      percent: 100,
    });
    expect(snapshot.totalBytes).toBe(10);
  });

  test("prefetch reports into the same registry", async () => {
    const downloads = registry();
    const engine = makeEngine({ cache: makeCache(new MemoryStore()) });

    await engine.prefetch(track, "s", downloads);

    const entry = downloads.snapshot().entries[0];
    expect(entry?.state).toBe("ready");
    expect(entry?.gainDb).toBeNull();
  });

  test("a failed download reports a short error code", async () => {
    const downloads = registry();
    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      deps: {
        downloadAudio: async () => {
          throw new MediaError("DOWNLOAD_ABORTED", "cancelled");
        },
      },
    });

    await engine.ensureCached(track, "s", downloads);

    const entry = downloads.snapshot().entries[0];
    expect(entry?.state).toBe("failed");
    expect(entry?.error).toBe("DOWNLOAD_ABORTED");
  });
});

describe("media engine resolve cache", () => {
  test("a repeated text query extracts once and replays the metadata", async () => {
    let extractions = 0;
    const engine = makeEngine({
      deps: {
        resolve: async () => {
          extractions += 1;
          return {
            videoId: "cachedVid",
            title: "Cached Song",
            webpageUrl: "https://www.youtube.com/watch?v=cachedVid",
            durationSec: 123,
            thumbnailUrl: "https://i.ytimg.com/vi/cachedVid/hqdefault.jpg",
            isPlaylist: false,
          };
        },
      },
    });

    const first = await engine.resolve("  Some  SONG ");
    const second = await engine.resolve("some song");

    expect(extractions).toBe(1);
    expect(second.title).toBe(first.title);
    expect(second.videoId).toBe("cachedVid");
    expect(second.webpageUrl).toBe("https://www.youtube.com/watch?v=cachedVid");
    expect(second.durationSec).toBe(123);
  });

  test("a URL query is a different cache key than its lowercased form", async () => {
    let extractions = 0;
    const engine = makeEngine({
      deps: {
        resolve: async (query) => {
          extractions += 1;
          return {
            videoId: "vid",
            title: query,
            webpageUrl: query,
            durationSec: 1,
            thumbnailUrl: null,
            isPlaylist: false,
          };
        },
      },
    });

    await engine.resolve("https://example.com/Song.mp3");
    await engine.resolve("https://example.com/Song.mp3");
    await engine.resolve("https://example.com/song.mp3");
    expect(extractions).toBe(2);
  });

  test("a failed extraction is not cached", async () => {
    let extractions = 0;
    const engine = makeEngine({
      deps: {
        resolve: async () => {
          extractions += 1;
          if (extractions === 1) throw new MediaError("EXTRACTOR_FAILED", "boom");
          return {
            videoId: "vid",
            title: "Recovered",
            webpageUrl: "https://www.youtube.com/watch?v=vid",
            durationSec: 1,
            thumbnailUrl: null,
            isPlaylist: false,
          };
        },
      },
    });

    await expect(engine.resolve("retry me")).rejects.toThrow(/boom/);
    const resolved = await engine.resolve("retry me");
    expect(resolved.title).toBe("Recovered");
    expect(extractions).toBe(2);
  });

  test("the session cache-first check wins over the resolve cache", async () => {
    const videoId = "dQw4w9WgXcQ";
    const cachedTrack = {
      ...track,
      id: videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    };
    const info = {
      videoId,
      title: "Download metadata",
      durationSec: 42,
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    };
    let extractions = 0;
    const engine = makeEngine({
      cache: makeCache(new MemoryStore()),
      deps: {
        downloadAudio: async () => ({ path: "/tmp/produced", info }),
        resolve: async () => {
          extractions += 1;
          return {
            videoId,
            title: "Extractor title",
            webpageUrl: cachedTrack.url,
            durationSec: 1,
            thumbnailUrl: null,
            isPlaylist: false,
          };
        },
      },
    });

    await engine.prepare(cachedTrack, "s");
    const resolved = await engine.resolve(cachedTrack.url, "s");
    expect(resolved.title).toBe("Download metadata");
    expect(extractions).toBe(0);
  });
});

describe("media engine stream prebuffer", () => {
  test("a stream that produces nothing within 4x the window falls back to piping", async () => {
    const silent = new PassThrough();
    const engine = makeEngine({
      streamPrebufferMs: 100,
      deps: {
        openAudioStream: async () => ({ process: fakeProcess(), stream: silent }),
        toPcm: () => silent,
      },
    });

    const startedAt = Date.now();
    const opened = await engine.open(track, { sessionId: "s" });
    expect(opened.source).toBe("stream");
    // 100 ms window × 4 = 400 ms, well under the old 15 s failure timeout.
    expect(Date.now() - startedAt).toBeLessThan(5_000);

    const received: Buffer[] = [];
    opened.stream.on("data", (chunk: Buffer) => received.push(chunk));
    silent.write(Buffer.alloc(1_000));
    await tick(20);
    expect(received.reduce((total, chunk) => total + chunk.length, 0)).toBeGreaterThan(0);

    opened.stop();
  });
});

function failingStream(message: string): PassThrough {
  const stream = new PassThrough();
  queueMicrotask(() => stream.destroy(new Error(message)));
  return stream;
}

const GOOGLEVIDEO = "https://rr1.googlevideo.com/videoplayback?itag=140&expire=1";

function streamResolver(overrides: {
  streamUrl?: string | null;
  onResolve?: (query: string) => void;
}): TrackResolver {
  return {
    async resolve(query) {
      overrides.onResolve?.(query);
      return {
        videoId: "vid",
        title: "Track",
        webpageUrl: track.url,
        durationSec: 30,
        thumbnailUrl: null,
        isPlaylist: false,
        ...(overrides.streamUrl === null
          ? {}
          : {
              streamUrl: overrides.streamUrl ?? GOOGLEVIDEO,
              headers: { "User-Agent": "com.google.ios.youtube/20.11.6" },
            }),
      };
    },
    async resolveSearch() {
      return [];
    },
  };
}

describe("media engine direct stream URLs", () => {
  test("a resolver streamUrl plays through ffmpeg on the URL and skips yt-dlp", async () => {
    let ytdlpStreams = 0;
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> | undefined;
    let capturedFilter: string | null | undefined;

    const engine = makeEngine({
      resolver: streamResolver({}),
      deps: {
        toPcmFromUrl: (url, headers, options) => {
          capturedUrl = url;
          capturedHeaders = headers;
          capturedFilter = options?.filter;
          return { stream: pcmStream(200_000), kill: () => undefined };
        },
        openAudioStream: async () => {
          ytdlpStreams += 1;
          return { process: fakeProcess(), stream: pcmStream(200_000) };
        },
      },
    });

    await engine.resolve("a song");
    const opened = await engine.open(track, { sessionId: "s" });
    opened.stop();

    expect(capturedUrl).toBe(GOOGLEVIDEO);
    expect(capturedHeaders).toEqual({ "User-Agent": "com.google.ios.youtube/20.11.6" });
    expect(capturedFilter).toBe("loudnorm=I=-16:TP=-1.5:LRA=11");
    expect(ytdlpStreams).toBe(0);
    expect(opened.source).toBe("stream");
  });

  test("a resolver without a streamUrl keeps the yt-dlp pipe", async () => {
    let urlAttempts = 0;
    let ytdlpStreams = 0;

    const engine = makeEngine({
      resolver: streamResolver({ streamUrl: null }),
      deps: {
        toPcmFromUrl: () => {
          urlAttempts += 1;
          return { stream: pcmStream(200_000), kill: () => undefined };
        },
        openAudioStream: async () => {
          ytdlpStreams += 1;
          return { process: fakeProcess(), stream: pcmStream(200_000) };
        },
      },
    });

    await engine.resolve("a song");
    const opened = await engine.open(track, { sessionId: "s" });
    opened.stop();

    expect(urlAttempts).toBe(0);
    expect(ytdlpStreams).toBe(1);
  });

  test("a 403 re-resolves exactly once, then falls back to the yt-dlp pipe", async () => {
    const resolved: string[] = [];
    let urlAttempts = 0;
    let ytdlpStreams = 0;

    const engine = makeEngine({
      resolver: streamResolver({ onResolve: (query) => resolved.push(query) }),
      deps: {
        toPcmFromUrl: () => {
          urlAttempts += 1;
          return {
            stream: failingStream("ffmpeg exited with code 1: HTTP error 403 Forbidden"),
            kill: () => undefined,
          };
        },
        openAudioStream: async () => {
          ytdlpStreams += 1;
          return { process: fakeProcess(), stream: pcmStream(200_000) };
        },
      },
    });

    await engine.resolve("a song");
    const opened = await engine.open(track, { sessionId: "s" });
    opened.stop();

    // One resolve to queue the track, one re-resolve to re-mint the URL.
    expect(resolved).toEqual(["a song", track.url]);
    expect(urlAttempts).toBe(2);
    expect(ytdlpStreams).toBe(1);
    expect(opened.source).toBe("stream");
  });

  test("a failure that a fresh URL cannot cure is not retried, but still degrades", async () => {
    let urlAttempts = 0;
    let resolves = 0;
    let ytdlpStreams = 0;

    const engine = makeEngine({
      resolver: streamResolver({ onResolve: () => (resolves += 1) }),
      deps: {
        toPcmFromUrl: () => {
          urlAttempts += 1;
          return {
            stream: failingStream('Could not start ffmpeg at "ffmpeg": spawn ffmpeg ENOENT'),
            kill: () => undefined,
          };
        },
        openAudioStream: async () => {
          ytdlpStreams += 1;
          return { process: fakeProcess(), stream: pcmStream(200_000) };
        },
      },
    });

    await engine.resolve("a song");
    const opened = await engine.open(track, { sessionId: "s" });
    opened.stop();

    expect(urlAttempts).toBe(1);
    expect(resolves).toBe(1);
    expect(ytdlpStreams).toBe(1);
  });

  test("the signed URL is never written to the resolve cache", async () => {
    const resolveCache = new ResolveCache();
    const engine = makeEngine({
      resolveCache,
      resolver: streamResolver({}),
      deps: {
        toPcmFromUrl: () => ({ stream: pcmStream(200_000), kill: () => undefined }),
      },
    });

    await engine.resolve("a song");

    const cached = resolveCache.get("a song");
    expect(cached?.videoId).toBe("vid");
    expect(JSON.stringify(cached)).not.toContain("googlevideo");
  });

  test("the stream URL is consumed by exactly one open", async () => {
    let urlAttempts = 0;
    let ytdlpStreams = 0;

    const engine = makeEngine({
      resolver: streamResolver({}),
      deps: {
        toPcmFromUrl: () => {
          urlAttempts += 1;
          return { stream: pcmStream(200_000), kill: () => undefined };
        },
        openAudioStream: async () => {
          ytdlpStreams += 1;
          return { process: fakeProcess(), stream: pcmStream(200_000) };
        },
      },
    });

    await engine.resolve("a song");
    (await engine.open(track, { sessionId: "s" })).stop();
    (await engine.open(track, { sessionId: "s" })).stop();

    expect(urlAttempts).toBe(1);
    expect(ytdlpStreams).toBe(1);
  });
});
