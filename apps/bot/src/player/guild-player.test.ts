import { describe, expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { AudioResource, DiscordGatewayAdapterCreator } from "@discordjs/voice";
import type { QueueTrack } from "@music/shared";
import { MediaError } from "../errors.js";
import { DownloadRegistry } from "../media/download-registry.js";
import type { MediaEngine } from "../media/media-engine.js";
import {
  GuildPlayer,
  type GuildPlayerOptions,
  StreamSemaphore,
  voiceStateLogFields,
} from "./guild-player.js";

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
  overrides: Partial<GuildPlayerOptions> = {},
): GuildPlayer {
  return new GuildPlayer({
    guildId: "guild-1",
    media,
    downloads: new DownloadRegistry({ maxBytes: 1_000, store: "local" }),
    adapterCreator: (() => undefined) as unknown as DiscordGatewayAdapterCreator,
    semaphore,
    idleTimeoutSeconds: 0,
    onError,
    ...overrides,
  });
}

function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A resource whose encoder is the only part playback cares about here. */
function fakeResource(encoder: unknown): AudioResource {
  return {
    encoder,
    volume: undefined,
    playStream: new PassThrough(),
    playbackDuration: 0,
    read: () => null,
  } as unknown as AudioResource;
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

describe("voiceStateLogFields", () => {
  test("carries the transition and omits an absent reason", () => {
    expect(voiceStateLogFields({ status: "connecting" }, { status: "ready" })).toEqual({
      from: "connecting",
      to: "ready",
    });
  });

  test("reads the disconnect reason defensively", () => {
    expect(voiceStateLogFields({ status: "ready" }, { status: "disconnected", reason: 2 })).toEqual(
      { from: "ready", to: "disconnected", reason: 2 },
    );

    expect(
      voiceStateLogFields({ status: "ready" }, { status: "disconnected", reason: "network" }),
    ).toEqual({ from: "ready", to: "disconnected", reason: "network" });

    expect(
      voiceStateLogFields({ status: "ready" }, { status: "disconnected", reason: null }),
    ).toEqual({ from: "ready", to: "disconnected" });
  });
});

describe("GuildPlayer opus bitrate", () => {
  test("applies the configured bitrate to every resource (second play included)", async () => {
    const applied: number[] = [];
    const player = makePlayer(new StreamSemaphore(4), playingMedia, undefined, {
      audioBitrateKbps: 96,
      createResource: () => fakeResource({ setBitrate: (bps: number) => applied.push(bps) }),
    });

    await player.enqueue([track("a"), track("b")]);
    await waitFor(() => player.getState().current?.id === "a");

    await player.skip();
    await waitFor(() => player.getState().current?.id === "b");

    // One encoder per resource: the track change had to re-apply it.
    expect(applied).toEqual([96_000, 96_000]);
  });

  test("warns once per session when the encoder has no bitrate control", async () => {
    const writes: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    try {
      const player = makePlayer(new StreamSemaphore(4), playingMedia, undefined, {
        createResource: () => fakeResource({}),
      });

      await player.enqueue([track("a"), track("b")]);
      await waitFor(() => player.getState().current?.id === "a");
      await player.skip();
      await waitFor(() => player.getState().current?.id === "b");
    } finally {
      spy.mockRestore();
    }

    expect(writes.filter((line) => line.includes("audio_bitrate_unsupported"))).toHaveLength(1);
  });
});

function prefetchMedia(
  prefetched: string[],
  cancelled: Array<{ sessionId?: string; trackId?: string }>,
): MediaEngine {
  return {
    ...playingMedia,
    prefetch: async (mediaTrack) => {
      prefetched.push(mediaTrack.id ?? mediaTrack.url);
    },
    cancelPrefetch: (sessionId, trackId) => {
      cancelled.push({ sessionId, trackId });
    },
  };
}

async function startWithQueued(player: GuildPlayer, ids: string[]): Promise<void> {
  await player.enqueue(ids.map(track));
  await waitFor(() => player.getState().current?.id === ids[0]);
}

describe("GuildPlayer prefetch scheduling", () => {
  test("enqueueing behind a playing track prefetches the new head once", async () => {
    const prefetched: string[] = [];
    const cancelled: Array<{ sessionId?: string; trackId?: string }> = [];
    const player = makePlayer(
      new StreamSemaphore(4),
      prefetchMedia(prefetched, cancelled),
      undefined,
      { prefetchDebounceMs: 0 },
    );

    await startWithQueued(player, ["a"]);
    await player.enqueue([track("b")]);
    await tick();

    expect(prefetched).toEqual(["b"]);
    expect(cancelled).toEqual([]);
  });

  test("enqueueing while idle does not prefetch", async () => {
    const prefetched: string[] = [];
    const cancelled: Array<{ sessionId?: string; trackId?: string }> = [];
    const player = makePlayer(
      new StreamSemaphore(4),
      prefetchMedia(prefetched, cancelled),
      undefined,
      { prefetchDebounceMs: 0 },
    );

    await player.enqueue([track("a")]);
    await tick();

    expect(prefetched).toEqual([]);
  });

  test("a burst of enqueues schedules one debounced prefetch", async () => {
    const prefetched: string[] = [];
    const cancelled: Array<{ sessionId?: string; trackId?: string }> = [];
    const player = makePlayer(
      new StreamSemaphore(4),
      prefetchMedia(prefetched, cancelled),
      undefined,
      { prefetchDebounceMs: 50 },
    );

    await startWithQueued(player, ["a"]);
    await player.enqueue([track("b")]);
    await player.enqueue([track("c")]);
    await player.enqueue([track("d")]);
    await tick(120);

    expect(prefetched).toEqual(["b"]);
  });

  test("removing the prefetched head aborts it and moves to the new head", async () => {
    const prefetched: string[] = [];
    const cancelled: Array<{ sessionId?: string; trackId?: string }> = [];
    const player = makePlayer(
      new StreamSemaphore(4),
      prefetchMedia(prefetched, cancelled),
      undefined,
      { prefetchDebounceMs: 0 },
    );

    await startWithQueued(player, ["a"]);
    await player.enqueue([track("b"), track("c")]);
    await tick();
    expect(prefetched).toEqual(["b"]);

    await player.remove(0);
    await tick();

    expect(cancelled).toEqual([{ sessionId: expect.any(String), trackId: "b" }]);
    expect(prefetched).toEqual(["b", "c"]);
  });

  test("moving a track to the head aborts the old prefetch", async () => {
    const prefetched: string[] = [];
    const cancelled: Array<{ sessionId?: string; trackId?: string }> = [];
    const player = makePlayer(
      new StreamSemaphore(4),
      prefetchMedia(prefetched, cancelled),
      undefined,
      { prefetchDebounceMs: 0 },
    );

    await startWithQueued(player, ["a"]);
    await player.enqueue([track("b"), track("c")]);
    await tick();

    await player.move(1, 0);
    await tick();

    expect(cancelled.map((entry) => entry.trackId)).toEqual(["b"]);
    expect(prefetched).toEqual(["b", "c"]);
  });

  test("shuffle recomputes the prefetch target", async () => {
    const prefetched: string[] = [];
    const cancelled: Array<{ sessionId?: string; trackId?: string }> = [];
    const player = makePlayer(
      new StreamSemaphore(4),
      prefetchMedia(prefetched, cancelled),
      undefined,
      { prefetchDebounceMs: 0, rng: () => 0 },
    );

    await startWithQueued(player, ["a"]);
    await player.enqueue([track("b"), track("c")]);
    await tick();

    await player.shuffle();
    await tick();

    // rng 0 swaps the two-item queue to [c, b].
    expect(prefetched).toEqual(["b", "c"]);
    expect(cancelled.map((entry) => entry.trackId)).toEqual(["b"]);
  });
});
