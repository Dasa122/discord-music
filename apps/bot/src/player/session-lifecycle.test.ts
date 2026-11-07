import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { DiscordGatewayAdapterCreator } from "@discordjs/voice";
import type { MediaEngine } from "../media/media-engine.js";
import { GuildPlayer, StreamSemaphore } from "./guild-player.js";
import { endsSession, SESSION_IDLE_TIMEOUT_SECONDS, shouldCancelIdle } from "./lifecycle.js";

function recordingMedia(events: string[]): MediaEngine {
  return {
    resolve: async () => {
      throw new Error("not used");
    },
    resolveSearch: async () => [],
    open: async () => ({ stream: new PassThrough(), stop: () => undefined, source: "stream" }),
    prepare: async (_track, sessionId) => {
      events.push(`prepare:${sessionId}`);
    },
    prefetch: async (_track, sessionId) => {
      events.push(`prefetch:${sessionId}`);
    },
    cancelPrefetch: (sessionId) => {
      events.push(`cancelPrefetch:${sessionId}`);
    },
    pin: async (sessionId, trackId) => {
      events.push(`pin:${sessionId}:${trackId}`);
    },
    unpin: async (sessionId, trackId) => {
      events.push(`unpin:${sessionId}:${trackId}`);
    },
    releaseSession: async (sessionId) => {
      events.push(`releaseSession:${sessionId}`);
    },
  };
}

function makePlayer(media: MediaEngine): GuildPlayer {
  return new GuildPlayer({
    guildId: "guild-1",
    media,
    adapterCreator: (() => undefined) as unknown as DiscordGatewayAdapterCreator,
    semaphore: new StreamSemaphore(2),
    idleTimeoutSeconds: 0,
  });
}

describe("session lifecycle decisions", () => {
  test("the idle timeout is 60 seconds", () => {
    expect(SESSION_IDLE_TIMEOUT_SECONDS).toBe(60);
  });

  test("stop, disconnect, destroyed and idle end the session; a move does not", () => {
    for (const reason of ["stop", "disconnect", "destroyed", "idle", "shutdown"] as const) {
      expect(endsSession(reason)).toBe(true);
    }
    expect(endsSession("move")).toBe(false);
  });

  test("a human with a queued track cancels the idle countdown", () => {
    expect(shouldCancelIdle(false, 1)).toBe(true);
    expect(shouldCancelIdle(false, 0)).toBe(false);
    expect(shouldCancelIdle(true, 2)).toBe(false);
    expect(shouldCancelIdle(false, null)).toBe(false);
  });
});

describe("GuildPlayer session teardown", () => {
  test("stop reaches endSession and releases the cache session", async () => {
    const events: string[] = [];
    const player = makePlayer(recordingMedia(events));
    const sessionId = player.beginSession();

    await player.stop();

    expect(events).toContain(`cancelPrefetch:${sessionId}`);
    expect(events).toContain(`releaseSession:${sessionId}`);
  });

  test("disconnect reaches endSession and releases the cache session", async () => {
    const events: string[] = [];
    const player = makePlayer(recordingMedia(events));
    const sessionId = player.beginSession();

    await player.disconnect();

    expect(events).toContain(`releaseSession:${sessionId}`);
  });

  test("destroy reaches endSession and releases the cache session", async () => {
    const events: string[] = [];
    const player = makePlayer(recordingMedia(events));
    const sessionId = player.beginSession();

    await player.destroy();

    expect(events).toContain(`releaseSession:${sessionId}`);
  });
});
