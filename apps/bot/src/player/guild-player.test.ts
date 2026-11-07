import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { DiscordGatewayAdapterCreator } from "@discordjs/voice";
import type { QueueTrack } from "@music/shared";
import { MediaError } from "../errors.js";
import { DownloadRegistry } from "../media/download-registry.js";
import type { MediaEngine } from "../media/media-engine.js";
import { GuildPlayer, StreamSemaphore } from "./guild-player.js";

function track(id: string): QueueTrack {
  return {
    id,
    title: `Track ${id}`,
    url: `https://example.com/${id}`,
    durationSec: 30,
    thumbnailUrl: null,
    source: "unknown",
    requestedBy: { id: "1", name: "Ada" },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const playingMedia: MediaEngine = {
  resolve: async () => {
    throw new Error("not used");
  },
  resolveSearch: async () => [],
  open: async () => ({ stream: new PassThrough(), stop: () => undefined, source: "stream" }),
};

function makePlayer(
  semaphore: StreamSemaphore,
  media: MediaEngine = playingMedia,
  onError?: (message: string) => void,
): GuildPlayer {
  return new GuildPlayer({
    guildId: "guild-1",
    media,
    downloads: new DownloadRegistry({ maxBytes: 1_000, store: "local" }),
    adapterCreator: (() => undefined) as unknown as DiscordGatewayAdapterCreator,
    semaphore,
    idleTimeoutSeconds: 0,
    onError,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("GuildPlayer.enqueue pre-flight", () => {
  test("a busy rejection leaves the queue untouched", async () => {
    const semaphore = new StreamSemaphore(1);
    semaphore.tryAcquire(); // another guild holds the only slot

    const player = makePlayer(semaphore);
    await expect(player.enqueue([track("a")])).rejects.toThrow(/maximum number of tracks/);
    expect(player.getState().queue).toHaveLength(0);
    expect(player.getState().current).toBeNull();
  });

  test("a successful enqueue is serialized with later mutations", async () => {
    const semaphore = new StreamSemaphore(2);
    const player = makePlayer(semaphore);

    const first = player.enqueue([track("a"), track("b")]);
    const second = player.enqueue([track("c")]);

    await expect(first).resolves.toBe(2);
    await expect(second).resolves.toBe(1);
    await waitFor(() => player.getState().current?.id === "a");
    expect(player.getState().queue.map((item) => item.id)).toEqual(["b", "c"]);
  });
});

describe("GuildPlayer.enqueue is not blocked by playback preparation", () => {
  test("enqueue resolves while the start is still preparing, with the track queued", async () => {
    const semaphore = new StreamSemaphore(2);
    const opening = deferred<void>();
    let prepareCalls = 0;

    const media: MediaEngine = {
      ...playingMedia,
      prepare: async () => {
        prepareCalls += 1;
      },
      open: async () => {
        await opening.promise;
        return { stream: new PassThrough(), stop: () => undefined, source: "stream" };
      },
    };

    const player = makePlayer(semaphore, media);
    const added = await player.enqueue([track("a")]);

    expect(added).toBe(1);
    // The reply is already possible: the track is queued and nothing is playing.
    expect(player.getState().current).toBeNull();
    expect(player.getState().queue.map((item) => item.id)).toEqual(["a"]);
    // Playback preparation is not part of enqueue (and no longer pre-downloads).
    expect(prepareCalls).toBe(0);

    opening.resolve();
    await waitFor(() => player.getState().current?.id === "a");
  });

  test("two rapid enqueues schedule exactly one start", async () => {
    const semaphore = new StreamSemaphore(2);
    let opens = 0;

    const media: MediaEngine = {
      ...playingMedia,
      open: async () => {
        opens += 1;
        return { stream: new PassThrough(), stop: () => undefined, source: "stream" };
      },
    };

    const player = makePlayer(semaphore, media);
    const first = player.enqueue([track("a")]);
    const second = player.enqueue([track("b")]);

    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(1);
    await waitFor(() => opens > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(opens).toBe(1);
    expect(player.getState().current?.id).toBe("a");
    expect(player.getState().queue.map((item) => item.id)).toEqual(["b"]);
  });

  test("a failing scheduled start surfaces one error notice without an unhandled rejection", async () => {
    const semaphore = new StreamSemaphore(2);
    const notices: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const media: MediaEngine = {
      ...playingMedia,
      open: async () => {
        throw new MediaError("EXTRACTOR_FAILED", "the extractor broke");
      },
    };

    try {
      const player = makePlayer(semaphore, media, (message) => notices.push(message));
      await expect(player.enqueue([track("a")])).resolves.toBe(1);

      await waitFor(() => notices.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("the extractor broke");
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
