import { describe, expect, test } from "bun:test";
import type { QueueTrack } from "@music/shared";
import {
  applyStartPoint,
  buildCollectionPreview,
  DISCORD_OPTION_TEXT_LIMIT,
  disabledPlaylistComponents,
  formatTrackDuration,
  PICKER_EXPIRED_MESSAGE,
  PlaylistStartError,
  parsePlaylistComponentId,
  planPlaylistAction,
  playlistComponentId,
  truncateText,
} from "./play-collection.js";

function track(index: number, overrides: Partial<QueueTrack> = {}): QueueTrack {
  return {
    id: `id-${index}`,
    title: `Track ${index}`,
    artist: "Artist",
    url: `https://www.youtube.com/watch?v=vid${index}`,
    durationSec: 222,
    thumbnailUrl: null,
    source: "youtube",
    requestedBy: { id: "user", name: "User" },
    ...overrides,
  };
}

describe("applyStartPoint", () => {
  const tracks = Array.from({ length: 6 }, (_, index) => track(index + 1));

  test("no option starts at #1 with every track", () => {
    const point = applyStartPoint(tracks, {});
    expect(point.startIndex).toBe(1);
    expect(point.tracks).toHaveLength(6);
  });

  test("start_at inside the range slices from that 1-based index", () => {
    const point = applyStartPoint(tracks, { startAt: 3 });
    expect(point.startIndex).toBe(3);
    expect(point.tracks.map((entry) => entry.title)).toEqual([
      "Track 3",
      "Track 4",
      "Track 5",
      "Track 6",
    ]);
  });

  test("start_at exactly at the length queues only the last track", () => {
    const point = applyStartPoint(tracks, { startAt: 6 });
    expect(point.startIndex).toBe(6);
    expect(point.tracks).toHaveLength(1);
  });

  test("start_at beyond the length names the real count", () => {
    const error = (() => {
      try {
        applyStartPoint(tracks, { startAt: 7 });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(PlaylistStartError);
    expect((error as PlaylistStartError).code).toBe("START_OUT_OF_RANGE");
    expect((error as PlaylistStartError).message).toContain("6 tracks");
  });

  test("start_from matches a case-insensitive substring", () => {
    const point = applyStartPoint(tracks, { startFrom: "track 4" });
    expect(point.startIndex).toBe(4);
    expect(point.tracks[0]?.title).toBe("Track 4");
  });

  test("start_from takes the first of multiple matches and logs it", () => {
    const repeated = [track(1, { title: "Song A" }), track(2, { title: "Song B" })];
    const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const point = applyStartPoint(repeated, { startFrom: "song" }, (message, fields) =>
      logs.push({ message, fields }),
    );
    expect(point.startIndex).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toBe("playlist_start_multiple_matches");
    expect(logs[0]?.fields?.matches).toBe(2);
  });

  test("start_from with no match suggests the first 5 titles", () => {
    const error = (() => {
      try {
        applyStartPoint(tracks, { startFrom: "nope" });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(PlaylistStartError);
    expect((error as PlaylistStartError).code).toBe("START_TRACK_NOT_FOUND");
    const message = (error as PlaylistStartError).message;
    for (let index = 1; index <= 5; index += 1) expect(message).toContain(`Track ${index}`);
    expect(message).not.toContain("Track 6");
  });

  test("both options are rejected", () => {
    const error = (() => {
      try {
        applyStartPoint(tracks, { startAt: 2, startFrom: "Track" });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(PlaylistStartError);
    expect((error as PlaylistStartError).code).toBe("START_OPTIONS_CONFLICT");
  });
});

describe("collection preview", () => {
  test("previews the first 10 tracks and shows a 25-option menu", () => {
    const tracks = Array.from({ length: 12 }, (_, index) =>
      track(index + 1, { title: `A very long track title number ${index + 1}` }),
    );
    const preview = buildCollectionPreview({
      token: "tok",
      title: "The Collection",
      badge: "Spotify",
      tracks,
    });

    expect(preview.hasMenu).toBe(true);
    const description = preview.embed.data.description ?? "";
    expect(description).toContain("Spotify · 12 tracks");
    expect(description).toContain("1. A very long track title number 1 — 3:42");
    expect(description).toContain("10. A very long track title number 10");
    expect(description).not.toContain("11. A very long");
    expect(preview.embed.data.footer?.text).toBeUndefined();

    const menu = preview.components[0]?.toJSON().components?.[0];
    expect(menu?.type).toBe(3); // string select
    expect(menu?.custom_id).toBe("playlist:start:tok");
    expect(menu?.options).toHaveLength(12);
    for (const option of menu?.options ?? []) {
      expect(option.label.length).toBeLessThanOrEqual(DISCORD_OPTION_TEXT_LIMIT);
      expect(option.description?.length ?? 0).toBeLessThanOrEqual(DISCORD_OPTION_TEXT_LIMIT);
      expect(option.value).toMatch(/^\d+$/);
    }
    expect(preview.components[1]?.toJSON().components).toHaveLength(2);
  });

  test("more than 25 tracks omits the menu and adds the footer hint", () => {
    const tracks = Array.from({ length: 30 }, (_, index) => track(index + 1));
    const preview = buildCollectionPreview({
      token: "tok",
      title: "Long List",
      badge: "YouTube",
      tracks,
    });

    expect(preview.hasMenu).toBe(false);
    expect(preview.components).toHaveLength(1);
    expect(preview.embed.data.footer?.text).toBe("Use start_at to begin later in this list.");
    expect(preview.embed.data.description).toContain("YouTube · 30 tracks");
  });

  test("long titles are truncated inside Discord limits", () => {
    const tracks = [track(1, { title: "x".repeat(400), artist: "y".repeat(200) })];
    const preview = buildCollectionPreview({
      token: "tok",
      title: "t".repeat(400),
      badge: "Spotify",
      tracks,
    });
    expect(preview.embed.data.title?.length).toBeLessThanOrEqual(256);
    const menu = preview.components[0]?.toJSON().components?.[0];
    const option = menu?.options?.[0];
    expect(option?.label.length).toBeLessThanOrEqual(DISCORD_OPTION_TEXT_LIMIT);
    expect(option?.description?.length).toBeLessThanOrEqual(DISCORD_OPTION_TEXT_LIMIT);
  });

  test("component ids round-trip the token and kind", () => {
    for (const kind of ["start", "all", "cancel"] as const) {
      const customId = playlistComponentId(kind, "token-123");
      expect(parsePlaylistComponentId(customId)).toEqual({ kind, token: "token-123" });
    }
    expect(parsePlaylistComponentId("player:queue")).toBeNull();
    expect(parsePlaylistComponentId("playlist:bogus:tok")).toBeNull();
    expect(parsePlaylistComponentId("playlist:start:")).toBeNull();
  });

  test("disabled controls for the post-choice message", () => {
    const rows = disabledPlaylistComponents("tok");
    const buttons = rows[0]?.toJSON().components ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });
});

describe("formatting helpers", () => {
  test("formats durations and unknown values", () => {
    expect(formatTrackDuration(222)).toBe("3:42");
    expect(formatTrackDuration(3_723)).toBe("1:02:03");
    expect(formatTrackDuration(null)).toBe("?:??");
  });

  test("truncates safely", () => {
    expect(truncateText("short", 10)).toBe("short");
    expect(truncateText("abcdefghij", 5)).toHaveLength(5);
    expect(truncateText("abcdefghij", 5).endsWith("…")).toBe(true);
    expect(truncateText("abcdefghij", 0)).toBe("");
  });
});

describe("playlist component plan", () => {
  const collection = {
    token: "tok",
    guildId: "guild",
    userId: "user",
    textChannelId: "channel",
    title: "Mix",
    badge: "Spotify",
    tracks: [track(1), track(2), track(3)],
    createdAt: 0,
  };

  test("a stale token is the uniform expired message", () => {
    const plan = planPlaylistAction({
      component: { kind: "all", token: "gone" },
      collection: null,
      userId: "user",
    });
    expect(plan).toEqual({ action: "expired", content: PICKER_EXPIRED_MESSAGE });
    expect(PICKER_EXPIRED_MESSAGE).toBe("This picker expired — run /play again.");
  });

  test("another user cannot use the picker; a manager can", () => {
    expect(
      planPlaylistAction({
        component: { kind: "all", token: "tok" },
        collection,
        userId: "someone-else",
      }).action,
    ).toBe("expired");
    expect(
      planPlaylistAction({
        component: { kind: "all", token: "tok" },
        collection,
        userId: "someone-else",
        isManager: true,
      }),
    ).toEqual({ action: "queue", startIndex: 1, tracks: collection.tracks });
  });

  test("Queue all queues everything; cancel queues nothing", () => {
    expect(
      planPlaylistAction({
        component: { kind: "all", token: "tok" },
        collection,
        userId: "user",
      }),
    ).toEqual({ action: "queue", startIndex: 1, tracks: collection.tracks });

    expect(
      planPlaylistAction({
        component: { kind: "cancel", token: "tok" },
        collection,
        userId: "user",
      }),
    ).toEqual({ action: "cancelled", content: "Playlist cancelled." });
  });

  test("a selected index queues from that track and rejects out-of-range values", () => {
    expect(
      planPlaylistAction({
        component: { kind: "start", token: "tok" },
        collection,
        userId: "user",
        values: ["2"],
      }),
    ).toEqual({ action: "queue", startIndex: 2, tracks: [track(2), track(3)] });

    const outOfRange = planPlaylistAction({
      component: { kind: "start", token: "tok" },
      collection,
      userId: "user",
      values: ["9"],
    });
    expect(outOfRange.action).toBe("expired");
  });
});
