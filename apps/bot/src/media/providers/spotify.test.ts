import { describe, expect, test } from "bun:test";
import { OdesliClient } from "./odesli.js";
import { createSpotifyProvider, MISSING_CREDENTIALS_MESSAGE } from "./spotify.js";
import { type FetchLike, MusicLinkError } from "./types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function trackPayload(id: string, title: string, durationMs = 222_000) {
  return {
    id,
    name: title,
    duration_ms: durationMs,
    artists: [{ name: "Artist One" }, { name: "Artist Two" }],
    album: {
      images: [
        { url: "https://i.scdn.co/image/small", width: 64 },
        { url: "https://i.scdn.co/image/large", width: 640 },
      ],
    },
  };
}

const TOKEN = "https://accounts.spotify.com/api/token";

function makeProvider(options: {
  calls: string[];
  handles: (url: string) => Response | undefined;
  credentials?: boolean;
}) {
  const fetchFn: FetchLike = async (input) => {
    options.calls.push(input);
    if (input === TOKEN) {
      return options.handles(input) ?? jsonResponse({ access_token: "tok", expires_in: 3_600 });
    }
    return options.handles(input) ?? jsonResponse({}, 404);
  };
  return createSpotifyProvider({
    odesli: new OdesliClient({ fetch: fetchFn }),
    fetch: fetchFn,
    now: () => 1_000,
    ...(options.credentials === false ? {} : { clientId: "id", clientSecret: "secret" }),
  });
}

describe("spotify provider", () => {
  test("caches the client-credentials token across lookups", async () => {
    const calls: string[] = [];
    const provider = makeProvider({
      calls,
      handles: (url) =>
        url.endsWith("/v1/tracks/t1") ? jsonResponse(trackPayload("t1", "Song")) : undefined,
    });

    const first = await provider.resolve(new URL("https://open.spotify.com/track/t1"));
    const second = await provider.resolve(new URL("https://open.spotify.com/track/t1"));

    expect(first.kind).toBe("track");
    expect(calls.filter((url) => url === TOKEN)).toHaveLength(1);
    expect(second.tracks[0]?.title).toBe("Song");
  });

  test("maps a track: title, artists, duration, artwork and source url", async () => {
    const calls: string[] = [];
    const provider = makeProvider({
      calls,
      handles: (url) =>
        url.endsWith("/v1/tracks/t1") ? jsonResponse(trackPayload("t1", "Song")) : undefined,
    });

    const resolved = await provider.resolve(new URL("https://open.spotify.com/track/t1"));
    expect(resolved.tracks[0]).toEqual({
      title: "Song",
      artists: ["Artist One", "Artist Two"],
      durationSec: 222,
      thumbnailUrl: "https://i.scdn.co/image/large",
      sourceUrl: "https://open.spotify.com/track/t1",
      provider: "spotify",
    });
  });

  test("maps an album with its name and album artwork fallback", async () => {
    const calls: string[] = [];
    const provider = makeProvider({
      calls,
      handles: (url) =>
        url.endsWith("/v1/albums/a1")
          ? jsonResponse({
              name: "The Album",
              images: [{ url: "https://i.scdn.co/image/album", width: 640 }],
              tracks: {
                total: 2,
                items: [trackPayload("t1", "One"), trackPayload("t2", "Two")],
              },
            })
          : undefined,
    });

    const resolved = await provider.resolve(new URL("https://open.spotify.com/album/a1"));
    expect(resolved.kind).toBe("album");
    expect(resolved.title).toBe("The Album");
    expect(resolved.tracks.map((track) => track.title)).toEqual(["One", "Two"]);
    expect(resolved.tracks[0]?.thumbnailUrl).toBe("https://i.scdn.co/image/large");
  });

  test("maps a playlist, skips unavailable entries and keeps its name", async () => {
    const calls: string[] = [];
    const provider = makeProvider({
      calls,
      handles: (url) => {
        if (url.endsWith("/v1/playlists/p1?fields=name")) {
          return jsonResponse({ name: "The Mix" });
        }
        if (url.endsWith("/v1/playlists/p1/tracks?limit=50&offset=0")) {
          return jsonResponse({
            items: [
              { track: trackPayload("t1", "One") },
              { track: null },
              { track: trackPayload("t2", "Two") },
            ],
          });
        }
        return undefined;
      },
    });

    const resolved = await provider.resolve(new URL("https://open.spotify.com/playlist/p1"));
    expect(resolved.kind).toBe("playlist");
    expect(resolved.title).toBe("The Mix");
    expect(resolved.tracks.map((track) => track.title)).toEqual(["One", "Two"]);
  });

  test("without credentials a track falls back to Odesli", async () => {
    const calls: string[] = [];
    const provider = makeProvider({
      credentials: false,
      calls,
      handles: (url) => {
        if (url.startsWith("https://api.song.link/")) {
          return jsonResponse({
            entityUniqueId: "SPOTIFY_SONG::t1",
            entitiesByUniqueId: {
              "SPOTIFY_SONG::t1": {
                title: "Odesli Song",
                artistName: "Odesli Artist",
                thumbnailUrl: "https://i.scdn.co/image/odesli",
              },
            },
            linksByPlatform: {
              youtube: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
            },
          });
        }
        return undefined;
      },
    });

    const resolved = await provider.resolve(new URL("https://open.spotify.com/track/t1"));
    expect(resolved.tracks[0]).toEqual({
      title: "Odesli Song",
      artists: ["Odesli Artist"],
      durationSec: null,
      thumbnailUrl: "https://i.scdn.co/image/odesli",
      sourceUrl: "https://open.spotify.com/track/t1",
      provider: "spotify",
      youtubeVideoId: "dQw4w9WgXcQ",
    });
    // No token request, no Web API request.
    expect(calls.some((url) => url.includes("api.spotify.com"))).toBe(false);
  });

  test("without credentials a collection fails with an actionable message", async () => {
    const provider = makeProvider({ credentials: false, calls: [], handles: () => undefined });
    const error = await provider
      .resolve(new URL("https://open.spotify.com/album/a1"))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MusicLinkError);
    expect((error as MusicLinkError).code).toBe("PROVIDER_AUTH_REQUIRED");
    expect((error as MusicLinkError).message).toBe(MISSING_CREDENTIALS_MESSAGE);
  });

  test("an Odesli YouTube link short-circuits the Web API", async () => {
    const calls: string[] = [];
    const provider = makeProvider({
      calls,
      handles: (url) => {
        if (url.startsWith("https://api.song.link/")) {
          return jsonResponse({
            entityUniqueId: "SPOTIFY_SONG::t1",
            entitiesByUniqueId: {
              "SPOTIFY_SONG::t1": { title: "Fast", artistName: "Artist" },
            },
            linksByPlatform: {
              youtube: { url: "https://www.youtube.com/watch?v=fast1234567" },
            },
          });
        }
        return undefined;
      },
    });

    const resolved = await provider.resolve(new URL("https://open.spotify.com/track/t1"));
    expect(resolved.tracks[0]?.youtubeVideoId).toBe("fast1234567");
    expect(calls.some((url) => url.includes("/v1/tracks/"))).toBe(false);
  });
});
