import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { DiscordGatewayAdapterCreator } from "@discordjs/voice";
import type { QueueTrack } from "@music/shared";
import { setLogLevel } from "../logger.js";
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
    cachedFileReady: () => false,
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
let stdout: { mockRestore(): void } | null = null;
let writes: string[] = [];

function installClock(start = 1_000_000): void {
  fakeNow = start;
  clock = spyOn(Date, "now").mockImplementation(() => fakeNow);
}

function installLogCapture(): void {
  writes = [];
  // Info goes to stdout and debug is filtered by level, so both matter here.
  setLogLevel("debug");
  const capture = (chunk: string | Uint8Array): boolean => {
    writes.push(String(chunk));
    return true;
  };
  stderr = spyOn(process.stderr, "write").mockImplementation(
    capture as typeof process.stderr.write,
  );
  stdout = spyOn(process.stdout, "write").mockImplementation(
    capture as typeof process.stdout.write,
  );
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
  stdout?.mockRestore();
  setLogLevel("info");
  clock = null;
  stderr = null;
  stdout = null;
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
      cachedFileReady: () => true,
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

  test("a loop replay of a track that genuinely ended", async () => {
    installClock();
    installLogCapture();
    const { media, opens } = fakeMedia();
    const player = makePlayer(media);

    await player.enqueue([track("a", 600)]);
    await waitUntil(() => opens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await player.setLoop("track");

    // The whole track played: 90% or more of the duration is a real end.
    fakeNow += 600_000;
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

describe("GuildPlayer truncation recovery in every loop mode", () => {
  for (const mode of ["off", "track", "queue"] as const) {
    test(`loop=${mode} recovers a truncated track instead of replaying it`, async () => {
      installClock();
      installLogCapture();
      const { media, opens } = fakeMedia();
      const player = makePlayer(media);

      await player.enqueue([track("a", 600)]);
      await waitUntil(() => opens.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await player.setLoop(mode);

      fakeNow += 60_000;
      player.audioPlayer.stop(true);

      await waitUntil(() => opens.length === 2);
      expect(opens[1]).toEqual({ startSec: 60, refreshStreamUrl: false, source: "stream" });
      expect(player.getState().current?.id).toBe("a");
      expect(logs("stream_truncated")).toHaveLength(1);
      const recovery = logs("stream_truncation_recovery");
      expect(recovery).toHaveLength(1);
      expect(recovery[0]).toMatchObject({ trackId: "a", action: "resume-ytdlp", startSec: 60 });
    });
  }

  test("loop=track does not replay a truncated track from 0", async () => {
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
    expect(opens.map((call) => call.startSec)).toEqual([0, 60]);
    expect(logs("stream_truncated")).toHaveLength(1);
  });

  test("loop=queue recovers the cut, then advances when the track really ends", async () => {
    installClock();
    installLogCapture();
    const { media, opens } = fakeMedia();
    const player = makePlayer(media);

    await player.enqueue([track("a", 600), track("b", 600)]);
    await waitUntil(() => opens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await player.setLoop("queue");

    fakeNow += 60_000;
    player.audioPlayer.stop(true);

    await waitUntil(() => opens.length === 2);
    expect(opens[1].startSec).toBe(60);
    expect(player.getState().current?.id).toBe("a");

    // From the resumed 60 s the rest of the track plays: a genuine end.
    fakeNow += 540_000;
    player.audioPlayer.stop(true);

    await waitUntil(() => player.getState().current?.id === "b");
    expect(opens[2].startSec).toBe(0);
    expect(logs("stream_truncated")).toHaveLength(1);
  });
});

describe("GuildPlayer truncation recovery budget", () => {
  test("a new track starts a fresh budget", async () => {
    installClock();
    installLogCapture();
    const { media, opens } = fakeMedia();
    const notices: string[] = [];
    const player = makePlayer(media, { onError: (message) => notices.push(message) });

    await player.enqueue([track("a", 600), track("b", 600)]);
    await waitUntil(() => opens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    fakeNow += 60_000; // 60/600
    player.audioPlayer.stop(true);
    await waitUntil(() => opens.length === 2);
    fakeNow += 60_000; // 120/600
    player.audioPlayer.stop(true);
    await waitUntil(() => opens.length === 3);
    fakeNow += 60_000; // 180/600, budget spent: advance to b
    player.audioPlayer.stop(true);
    await waitUntil(() => player.getState().current?.id === "b");
    expect(opens[3].startSec).toBe(0);

    fakeNow += 60_000; // b is truncated too, with its own budget
    player.audioPlayer.stop(true);
    await waitUntil(() => opens.length === 5);
    expect(opens.map((call) => call.startSec)).toEqual([0, 60, 120, 0, 60]);
    expect(notices).toHaveLength(1);
  });

  test("a seek resets the budget", async () => {
    installClock();
    installLogCapture();
    const { media, opens } = fakeMedia();
    const player = makePlayer(media);

    await player.enqueue([track("a", 600)]);
    await waitUntil(() => opens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    fakeNow += 60_000;
    player.audioPlayer.stop(true);
    await waitUntil(() => opens.length === 2);
    fakeNow += 60_000;
    player.audioPlayer.stop(true);
    await waitUntil(() => opens.length === 3);

    await player.seek(30);
    await waitUntil(() => opens.length === 4);
    expect(opens[3].startSec).toBe(30);

    fakeNow += 60_000; // 90/600, truncated again
    player.audioPlayer.stop(true);
    await waitUntil(() => opens.length === 5);
    expect(opens[4].startSec).toBe(90);
  });

  test("a loop replay keeps the budget, so a cut track stops instead of looping", async () => {
    installClock();
    installLogCapture();
    const { media, opens } = fakeMedia();
    const notices: string[] = [];
    const player = makePlayer(media, { onError: (message) => notices.push(message) });

    await player.enqueue([track("a", 600)]);
    await waitUntil(() => opens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await player.setLoop("track");

    fakeNow += 60_000;
    player.audioPlayer.stop(true);
    await waitUntil(() => opens.length === 2);
    fakeNow += 60_000;
    player.audioPlayer.stop(true);
    await waitUntil(() => opens.length === 3);

    // Play the rest: a real end, so loop=track replays from 0.
    fakeNow += 600_000;
    player.audioPlayer.stop(true);
    await waitUntil(() => opens.length === 4);
    expect(opens[3].startSec).toBe(0);

    // The replay did not refund the budget: this cut cannot be recovered.
    fakeNow += 60_000;
    player.audioPlayer.stop(true);
    await waitUntil(() => notices.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opens).toHaveLength(4);
    expect(player.getState().current).toBeNull();
  });
});

describe("GuildPlayer partial-cache recovery", () => {
  test("a partial cache is not resumed; it asks for a fresh URL at the offset", async () => {
    installClock();
    installLogCapture();
    const { media, opens } = fakeMedia({
      cachedBytes: () => 4_096,
      cachedFileReady: () => false,
      providesStreamUrls: () => true,
    });
    const downloads = new DownloadRegistry({ maxBytes: 1_000_000, store: "local" });
    downloads.begin("guild-1", "a", "Track a");
    downloads.progress("a", { bytes: 4_096, totalBytes: 10_000 });
    const player = makePlayer(media, { downloads });

    await player.enqueue([track("a", 600)]);
    await waitUntil(() => opens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    fakeNow += 60_000;
    player.audioPlayer.stop(true);

    await waitUntil(() => opens.length === 2);
    // retry-url, never resume-cache: the file would hit EOF immediately.
    expect(opens[1]).toEqual({ startSec: 60, refreshStreamUrl: true, source: "stream" });
    expect(logs("stream_truncation_recovery")[0]).toMatchObject({
      action: "retry-url",
      startSec: 60,
    });
    const incomplete = logs("cache_incomplete");
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toMatchObject({ trackId: "a", bytes: 4_096, totalBytes: 10_000 });
  });

  test("a partial cache with no URL resumes through the yt-dlp pipe", async () => {
    installClock();
    installLogCapture();
    const { media, opens } = fakeMedia({
      cachedBytes: () => 4_096,
      cachedFileReady: () => false,
      providesStreamUrls: () => false,
    });
    const player = makePlayer(media);

    await player.enqueue([track("a", 600)]);
    await waitUntil(() => opens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    fakeNow += 60_000;
    player.audioPlayer.stop(true);

    await waitUntil(() => opens.length === 2);
    expect(opens[1]).toEqual({ startSec: 60, refreshStreamUrl: false, source: "stream" });
    expect(logs("stream_truncation_recovery")[0]).toMatchObject({ action: "resume-ytdlp" });
    expect(logs("cache_incomplete")).toHaveLength(1);
  });
});
