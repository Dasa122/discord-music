import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { DiscordGatewayAdapterCreator } from "@discordjs/voice";
import type { QueueTrack } from "@music/shared";
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

const silentMedia: MediaEngine = {
  resolve: async () => {
    throw new Error("not used");
  },
  resolveSearch: async () => [],
  open: async () => ({ stream: new PassThrough(), stop: () => undefined }),
};

function makePlayer(semaphore: StreamSemaphore): GuildPlayer {
  return new GuildPlayer({
    guildId: "guild-1",
    media: silentMedia,
    adapterCreator: (() => undefined) as unknown as DiscordGatewayAdapterCreator,
    semaphore,
    idleTimeoutSeconds: 0,
  });
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
    expect(player.getState().queue.map((item) => item.id)).toEqual(["b", "c"]);
  });
});
