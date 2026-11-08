import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { DiscordGatewayAdapterCreator } from "@discordjs/voice";
import type { QueueTrack } from "@music/shared";
import { DownloadRegistry } from "../media/download-registry.js";
import type { MediaEngine } from "../media/media-engine.js";
import { GuildPlayer, type GuildPlayerOptions, StreamSemaphore } from "./guild-player.js";

function track(id: string, durationSec: number): QueueTrack {
  return {
    id,
    title: `Track ${id}`,
    url: `https://example.com/${id}`,
    durationSec,
    thumbnailUrl: null,
    source: "unknown",
    requestedBy: { id: "1", name: "Ada" },
  };
}

interface OpenCall {
  startSec: number;
  refreshStreamUrl: boolean;
  source: "cache" | "stream";
}

function fakeMedia(overrides: Partial<MediaEngine> = {}): {
  media: MediaEngine;
  opens: OpenCall[];
} {
  const opens: OpenCall[] = [];
  const media: MediaEngine = {
    resolve: async () => {
      throw new Error("not used");
    },
    resolveSearch: async () => [],
    open: async (_track, options = {}) => {
      opens.push({
        startSec: options.startSec ?? 0,
        refreshStreamUrl: options.refreshStreamUrl ?? false,
        source: "stream",
      });
      return { stream: new PassThrough(), stop: () => undefined, source: "stream" };
    },
    cachedBytes: () => null,
    providesStreamUrls: () => false,
    ...overrides,
  };
  return { media, opens };
}

function makePlayer(media: MediaEngine, overrides: Partial<GuildPlayerOptions> = {}): GuildPlayer {
  return new GuildPlayer({
    guildId: "guild-1",
    media,
    downloads: new DownloadRegistry({ maxBytes: 1_000, store: "local" }),
    adapterCreator: (() => undefined) as unknown as DiscordGatewayAdapterCreator,
    semaphore: new StreamSemaphore(4),
    idleTimeoutSeconds: 0,
    ...overrides,
  });
}

/** Iteration-bounded wait: the fake clock below freezes `Date.now`. */
async function waitUntil(predicate: () => boolean, attempts = 400): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for the player");
}

let fakeNow = 0;
let clock: { mockRestore(): void } | null = null;
let stderr: { mockRestore(): void } | null = null;
let writes: string[] = [];

function installClock(start = 1_000_000): void {
  fakeNow = start;
  clock = spyOn(Date, "now").mockImplementation(() => fakeNow);
}

function installLogCapture(): void {
  writes = [];
  stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
}

function logs(message: string): Array<Record<string, unknown>> {
  return writes
    .join("")
    .split("\n")
    .filter((line) => line.includes(`"msg":"${message}"`))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  clock?.mockRestore();
  stderr?.mockRestore();
  clock = null;
  stderr = null;
  writes = [];
});

describe("GuildPlayer truncation recovery", () => {
  test("resumes a stream that ended early at the reported position", async () => {
    installClock();
    installLogCapture();
    const { media, opens } = fakeMedia();
    const notices: string[] = [];
    const player = makePlayer(media, { onError: (message) => notices.push(message) });

    await player.enqueue([track("a", 600)]);
    await waitUntil(() => opens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    fakeNow += 60_000;
    player.audioPlayer.stop(true);

    await waitUntil(() => opens.length === 2);
    expect(opens[1]).toEqual({ startSec: 60, refreshStreamUrl: false, source: "stream" });
    expect(notices).toEqual([]);

    const truncated = logs("stream_truncated");
    expect(truncated).toHaveLength(1);
    expect(truncated[0]).toMatchObject({
      trackId: "a",
      positionSec: 60,
      durationSec: 600,
      source: "stream",
      cachedBytes: 0,
    });
  });

  test("a complete cache wins over a fresh URL", async () => {
    installClock();
    installLogCapture();
    const { media, opens } = fakeMedia({
      cachedBytes: () => 4_096,
      providesStreamUrls: () => true,
    });
    const player = makePlayer(media);

    await player.enqueue([track("a", 600)]);
    await waitUntil(() => opens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    fakeNow += 60_000;
    player.audioPlayer.stop(true);

    await waitUntil(() => opens.length === 2);
    // resume-cache never asks the resolver for a new URL.
    expect(opens[1].refreshStreamUrl).toBe(false);
    expect(logs("stream_truncated")[0]).toMatchObject({ cachedBytes: 4_096 });
  });

  test("a resolver URL resumes with a refreshed URL at the offset", async () => {
    installClock();
    installLogCapture();
    const { media, opens } = fakeMedia({ providesStreamUrls: () => true });
    const player = makePlayer(media);

    await player.enqueue([track("a", 600)]);
    await waitUntil(() => opens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    fakeNow += 60_000;
    player.audioPlayer.stop(true);

    await waitUntil(() => opens.length === 2);
    expect(opens[1]).toEqual({ startSec: 60, refreshStreamUrl: true, source: "stream" });
  });

  test("two recoveries, then the queue advances with exactly one notice", async () => {
    installClock();
    installLogCapture();
    const { media, opens } = fakeMedia();
    const notices: string[] = [];
    const player = makePlayer(media, { onError: (message) => notices.push(message) });

    await player.enqueue([track("a", 600)]);
    await waitUntil(() => opens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    fakeNow += 60_000;
    player.audioPlayer.stop(true);
    await waitUntil(() => opens.length === 2);

    fakeNow += 60_000;
    player.audioPlayer.stop(true);
    await waitUntil(() => opens.length === 3);

    fakeNow += 60_000;
    player.audioPlayer.stop(true);
    await waitUntil(() => notices.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(opens.map((call) => call.startSec)).toEqual([0, 60, 120]);
    expect(player.getState().current).toBeNull();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("stopped early");
    expect(logs("stream_truncated")).toHaveLength(3);
  });
});

describe("GuildPlayer truncation guard does not fire", () => {
  test("a track that ends at 90% of its duration", async () => {
    installClock();
    installLogCapture();
    const { media, opens } = fakeMedia();
    const player = makePlayer(media);

    await player.enqueue([track("a", 30), track("b", 30)]);
    await waitUntil(() => opens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    fakeNow += 27_000;
    player.audioPlayer.stop(true);

    await waitUntil(() => opens.length === 2);
    expect(opens[1].startSec).toBe(0);
    expect(player.getState().current?.id).toBe("b");
    expect(logs("stream_truncated")).toHaveLength(0);
  });

  test("a user skip", async () => {
    installClock();
    installLogCapture();
    const { media, opens } = fakeMedia();
    const player = makePlayer(media);

    await player.enqueue([track("a", 600), track("b", 600)]);
    await waitUntil(() => opens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    fakeNow += 60_000;
    await player.skip();

    await waitUntil(() => player.getState().current?.id === "b");
    expect(opens[1].startSec).toBe(0);
    expect(logs("stream_truncated")).toHaveLength(0);
  });

  test("a manual stop", async () => {
    installClock();
    installLogCapture();
    const { media, opens } = fakeMedia();
    const player = makePlayer(media);

    await player.enqueue([track("a", 600)]);
    await waitUntil(() => opens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    fakeNow += 60_000;
    await player.stop();

    expect(player.getState().current).toBeNull();
    expect(logs("stream_truncated")).toHaveLength(0);
  });

  test("a loop replay", async () => {
    installClock();
    installLogCapture();
    const { media, opens } = fakeMedia();
    const player = makePlayer(media);

    await player.enqueue([track("a", 600)]);
    await waitUntil(() => opens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await player.setLoop("track");

    fakeNow += 60_000;
    player.audioPlayer.stop(true);

    await waitUntil(() => opens.length === 2);
    expect(opens[1].startSec).toBe(0);
    expect(player.getState().current?.id).toBe("a");
    expect(logs("stream_truncated")).toHaveLength(0);
  });

  test("the guard can be disabled entirely", async () => {
    installClock();
    installLogCapture();
    const { media, opens } = fakeMedia();
    const player = makePlayer(media, { truncationGuard: false });

    await player.enqueue([track("a", 600), track("b", 600)]);
    await waitUntil(() => opens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    fakeNow += 60_000;
    player.audioPlayer.stop(true);

    await waitUntil(() => player.getState().current?.id === "b");
    expect(opens[1].startSec).toBe(0);
    expect(logs("stream_truncated")).toHaveLength(0);
  });
});
