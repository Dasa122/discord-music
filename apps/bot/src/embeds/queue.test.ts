import { describe, expect, test } from "bun:test";
import type { PlayerState, QueueTrack } from "@music/shared";
import { buildQueueComponents, buildQueueEmbed, clampQueuePage, queuePageCount } from "./queue.js";

function track(index: number): QueueTrack {
  return {
    id: `track-${index}`,
    title: `Track ${index}`,
    url: `https://example.com/${index}`,
    durationSec: 60,
    thumbnailUrl: null,
    source: "unknown",
    requestedBy: { id: "1", name: "Ada" },
  };
}

function state(count: number): PlayerState {
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
    current: track(0),
    queue: Array.from({ length: count }, (_, index) => track(index + 1)),
    updatedAt: "2026-11-06T12:00:00.000Z",
  };
}

describe("queue pagination math", () => {
  test("computes page counts and clamps out-of-range pages", () => {
    expect(queuePageCount(0)).toBe(1);
    expect(queuePageCount(1)).toBe(1);
    expect(queuePageCount(10)).toBe(1);
    expect(queuePageCount(11)).toBe(2);
    expect(queuePageCount(25)).toBe(3);
    expect(clampQueuePage(0, 3)).toBe(1);
    expect(clampQueuePage(99, 3)).toBe(3);
    expect(clampQueuePage(Number.NaN, 3)).toBe(1);
  });

  test("renders the requested slice and page header", () => {
    const page2 = buildQueueEmbed(state(25), 2).toJSON();
    expect(page2.description).toContain("Page 2/3 · 25 tracks");
    expect(page2.description).toContain("**11.**");
    expect(page2.description).toContain("**20.**");
    expect(page2.description).not.toContain("**21.**");

    const page3 = buildQueueEmbed(state(25), 99).toJSON();
    expect(page3.description).toContain("Page 3/3 · 25 tracks");
    expect(page3.description).toContain("**21.**");
    expect(page3.description).toContain("**25.**");
  });

  test("renders an empty queue safely", () => {
    const embed = buildQueueEmbed(state(0), 1).toJSON();
    expect(embed.description).toContain("Page 1/1 · 0 tracks");
    expect(embed.description).toContain("The queue is empty.");
  });
});

describe("buildQueueComponents", () => {
  test("disables Prev on the first page and Next on the last page", () => {
    const first = buildQueueComponents(1, 3).toJSON();
    expect(first.components[0]?.type === 2 ? first.components[0].disabled : null).toBe(true);
    expect(first.components[1]?.type === 2 ? first.components[1].disabled : null).toBe(false);

    const last = buildQueueComponents(3, 3).toJSON();
    expect(last.components[0]?.type === 2 ? last.components[0].disabled : null).toBe(false);
    expect(last.components[1]?.type === 2 ? last.components[1].disabled : null).toBe(true);
  });
});
