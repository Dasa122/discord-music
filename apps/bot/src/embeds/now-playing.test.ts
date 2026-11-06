import { describe, expect, test } from "bun:test";
import type { PlayerState, QueueTrack } from "@music/shared";
import { COLORS } from "./colors.js";
import {
  buildFinishedEmbed,
  buildNowPlayingComponents,
  buildNowPlayingEmbed,
} from "./now-playing.js";

const track: QueueTrack = {
  id: "abc123",
  title: "A Very Long Song Title",
  url: "https://www.youtube.com/watch?v=abc123",
  durationSec: 245,
  thumbnailUrl: "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
  source: "youtube",
  requestedBy: { id: "42", name: "Ada" },
};

function state(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    guildId: "guild-1",
    connected: true,
    voiceChannelId: "voice-1",
    textChannelId: "text-1",
    playing: true,
    paused: false,
    positionSec: 61,
    volume: 80,
    loop: "queue",
    current: track,
    queue: [{ ...track, id: "next", title: "Next Song" }],
    updatedAt: "2026-11-06T12:00:00.000Z",
    ...overrides,
  };
}

describe("buildNowPlayingEmbed", () => {
  test("renders the spec fields, title link, and playing colour", () => {
    const embed = buildNowPlayingEmbed(track, state()).toJSON();

    expect(embed.color).toBe(COLORS.playing);
    expect(embed.title).toBe(track.title);
    expect(embed.url).toBe(track.url);
    expect(embed.thumbnail?.url).toBe(track.thumbnailUrl);
    expect(embed.description).toBe("Requested by <@42>");

    const fields = new Map((embed.fields ?? []).map((field) => [field.name, field.value]));
    expect(fields.get("Duration")).toBe("4:05");
    expect(fields.get("Position")).toBe("1:01");
    expect(fields.get("Volume")).toBe("80%");
    expect(fields.get("Loop")).toBe("Queue");
    expect(fields.get("Queue")).toBe("1 track");
    expect(embed.timestamp).toBe("2026-11-06T12:00:00.000Z");
  });

  test("uses the paused colour and idle colour", () => {
    expect(buildNowPlayingEmbed(track, state({ paused: true, playing: false })).data.color).toBe(
      COLORS.paused,
    );
    expect(buildNowPlayingEmbed(track, state({ paused: false, playing: false })).data.color).toBe(
      COLORS.idle,
    );
  });

  test("footer includes bot and guild names", () => {
    const embed = buildNowPlayingEmbed(track, state(), {
      botName: "Music Bot",
      guildName: "Test Guild",
    }).toJSON();
    expect(embed.footer?.text).toBe("Music Bot • Test Guild");
  });
});

describe("buildNowPlayingComponents", () => {
  test("uses the documented custom ids and pause/resume label", () => {
    const playing = buildNowPlayingComponents(state()).toJSON();
    const ids = playing.components.map((component) => {
      if (component.type !== 2) return "";
      return component.custom_id;
    });

    expect(ids).toEqual([
      "player:pause:abc123",
      "player:skip:abc123",
      "player:stop:abc123",
      "player:queue",
      "player:shuffle:abc123",
    ]);

    const paused = buildNowPlayingComponents(state({ paused: true, playing: false })).toJSON();
    const pauseButton = paused.components[0];
    expect(pauseButton?.type === 2 ? pauseButton.label : null).toBe("Resume");
  });

  test("disables every button when requested", () => {
    const row = buildNowPlayingComponents(state(), { disabled: true }).toJSON();
    for (const component of row.components) {
      if (component.type === 2) expect(component.disabled).toBe(true);
    }
  });
});

test("buildFinishedEmbed is grey and has no buttons by construction", () => {
  const embed = buildFinishedEmbed(track).toJSON();
  expect(embed.color).toBe(COLORS.idle);
  expect(embed.description).toBe("Finished playing.");
});
