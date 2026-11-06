import { describe, expect, test } from "bun:test";
import type { PlayerState } from "@music/shared";
import { resolveTextChannel } from "./now-playing.js";

function state(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    guildId: "guild-1",
    connected: true,
    voiceChannelId: "voice-1",
    textChannelId: "text-1",
    playing: true,
    paused: false,
    positionSec: 0,
    volume: 100,
    loop: "off",
    current: null,
    queue: [],
    updatedAt: "2026-11-06T12:00:00.000Z",
    ...overrides,
  };
}

describe("resolveTextChannel", () => {
  test("adopts a text channel reported by the player", () => {
    expect(resolveTextChannel(null, state({ textChannelId: "text-2" }))).toBe("text-2");
  });

  test("clears the channel when the player disconnects", () => {
    expect(
      resolveTextChannel("text-1", state({ textChannelId: null, voiceChannelId: null })),
    ).toBeNull();
  });

  test("keeps the channel while still connected without a new one", () => {
    expect(resolveTextChannel("text-1", state({ textChannelId: null }))).toBe("text-1");
  });
});
