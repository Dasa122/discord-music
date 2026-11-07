import { describe, expect, test } from "bun:test";
import { buildTrackSearchQuery, createMusicLinkResolver, providerArtist } from "./index.js";
import { type FetchLike, MusicLinkError } from "./types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function playlistTrack(index: number) {
  return {
    track: {
      id: `t${index}`,
      name: `Track ${index}`,
      duration_ms: 60_000,
      artists: [{ name: "Artist" }],
    },
  };
}

describe("track search query", () => {
  test("joins title and every artist with single spaces", () => {
    expect(buildTrackSearchQuery({ title: "  Song  ", artists: ["A", "B"] })).toBe("Song A B");
    expect(buildTrackSearchQuery({ title: "Song", artists: [] })).toBe("Song");
    expect(buildTrackSearchQuery({ title: "Song", artists: ["   "] })).toBe("Song");
    expect(
      buildTrackSearchQuery({ title: "  Song\n", artists: ["Artist  One", "Artist Two "] }),
    ).toBe("Song Artist One Artist Two");
    expect(buildTrackSearchQuery({ title: "Song", artists: ["A"] })).not.toContain("  ");
  });

  test("providerArtist joins names, or null when empty", () => {
    expect(providerArtist({ artists: ["A", "B"] })).toBe("A, B");
    expect(providerArtist({ artists: [] })).toBeNull();
    expect(providerArtist({ artists: ["  "] })).toBeNull();
  });
});

describe("music link resolver", () => {
  test("caps a 120-track Spotify playlist at the requested count", async () => {
    const pageCalls: string[] = [];
    const fetchFn: FetchLike = async (input) => {
      if (input === "https://accounts.spotify.com/api/token") {
        return jsonResponse({ access_token: "tok", expires_in: 3_600 });
      }
      if (input.endsWith("/v1/playlists/p1?fields=name")) {
        return jsonResponse({ name: "Long Playlist" });
      }
      if (input.includes("/v1/playlists/p1/tracks")) {
        pageCalls.push(input);
        const offset = Number(new URL(input).searchParams.get("offset") ?? "0");
        const remaining = 120 - offset;
        const count = Math.max(0, Math.min(50, remaining));
        return jsonResponse({
          items: Array.from({ length: count }, (_, index) => playlistTrack(offset + index + 1)),
        });
      }
      return jsonResponse({}, 404);
    };

    const resolver = createMusicLinkResolver({
      fetch: fetchFn,
      spotifyClientId: "id",
      spotifyClientSecret: "secret",
      maxTracks: 100,
    });

    const resolved = await resolver.resolve("https://open.spotify.com/playlist/p1", 50);
    expect(resolved.tracks).toHaveLength(50);
    expect(resolved.title).toBe("Long Playlist");
    // One page is enough for 50; it must not fetch the whole 120.
    expect(pageCalls).toHaveLength(1);

    const cappedAt100 = await createMusicLinkResolver({
      fetch: fetchFn,
      spotifyClientId: "id",
      spotifyClientSecret: "secret",
      maxTracks: 100,
    }).resolve("https://open.spotify.com/playlist/p1");
    expect(cappedAt100.tracks).toHaveLength(100);
    // The second call added offsets 0 and 50 only; 100 was never needed.
    expect(pageCalls).toHaveLength(3);
  });

  test("a song.link YouTube hit keeps the source metadata and needs no search", async () => {
    const fetchFn: FetchLike = async (input) => {
      if (input.startsWith("https://api.song.link/")) {
        return jsonResponse({
          entityUniqueId: "SPOTIFY_SONG::abc",
          entitiesByUniqueId: {
            "SPOTIFY_SONG::abc": {
              title: "Track",
              artistName: "Artist",
              thumbnailUrl: "https://i.scdn.co/image/x",
            },
          },
          linksByPlatform: {
            youtube: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
          },
        });
      }
      return jsonResponse({}, 404);
    };

    const resolver = createMusicLinkResolver({ fetch: fetchFn });
    const resolved = await resolver.resolve("https://open.spotify.com/track/abc", 50);
    expect(resolved.tracks).toHaveLength(1);
    expect(resolved.tracks[0]).toEqual({
      title: "Track",
      artists: ["Artist"],
      durationSec: null,
      thumbnailUrl: "https://i.scdn.co/image/x",
      sourceUrl: "https://open.spotify.com/track/abc",
      provider: "spotify",
      youtubeVideoId: "dQw4w9WgXcQ",
    });
  });

  test("an unsupported link is a typed failure and never a fetch", async () => {
    const resolver = createMusicLinkResolver({
      fetch: async () => {
        throw new Error("must not fetch");
      },
    });
    const error = await resolver
      .resolve("https://example.com/track/abc")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MusicLinkError);
    expect((error as MusicLinkError).code).toBe("PROVIDER_UNAVAILABLE");
  });

  test("parse() only matches provider links", () => {
    const resolver = createMusicLinkResolver();
    expect(resolver.parse("https://open.spotify.com/track/abc")?.provider).toBe("spotify");
    expect(resolver.parse("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(resolver.parse("just text")).toBeNull();
  });
});
