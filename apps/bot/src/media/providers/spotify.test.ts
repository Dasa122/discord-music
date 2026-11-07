import { describe, expect, test } from "bun:test";
import { OdesliClient } from "./odesli.js";
import {
  createSpotifyProvider,
  MISSING_CREDENTIALS_MESSAGE,
  SPOTIFY_UNREADABLE_MESSAGE,
} from "./spotify.js";
import { type FetchLike, MusicLinkError } from "./types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
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
const TRACK_URL = "https://open.spotify.com/track/t1";
const OEMBED_URL = `https://open.spotify.com/oembed?url=${encodeURIComponent(TRACK_URL)}`;

function ogPage(
  options: {
    title?: string;
    description?: string;
    type?: string;
    image?: string;
    duration?: string;
    url?: string;
  } = {},
): string {
  const tags: string[] = [];
  if (options.title !== undefined)
    tags.push(`<meta property="og:title" content="${options.title}"/>`);
  if (options.description !== undefined) {
    tags.push(`<meta property="og:description" content="${options.description}"/>`);
  }
  if (options.type !== undefined) tags.push(`<meta property="og:type" content="${options.type}"/>`);
  if (options.image !== undefined) {
    tags.push(`<meta property="og:image" content="${options.image}"/>`);
  }
  if (options.duration !== undefined) {
    tags.push(`<meta name="music:duration" content="${options.duration}"/>`);
  }
  tags.push(`<meta property="og:url" content="${options.url ?? TRACK_URL}"/>`);
  return `<html><head>${tags.join("")}</head><body><script>window.__NEXT_DATA__={}</script></body></html>`;
}

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

describe("spotify provider with credentials", () => {
  test("caches the client-credentials token across lookups", async () => {
    const calls: string[] = [];
    const provider = makeProvider({
      calls,
      handles: (url) =>
        url.endsWith("/v1/tracks/t1") ? jsonResponse(trackPayload("t1", "Song")) : undefined,
    });

    const first = await provider.resolve(new URL(TRACK_URL));
    const second = await provider.resolve(new URL(TRACK_URL));

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

    const resolved = await provider.resolve(new URL(TRACK_URL));
    expect(resolved.tracks[0]).toEqual({
      title: "Song",
      artists: ["Artist One", "Artist Two"],
      durationSec: 222,
      thumbnailUrl: "https://i.scdn.co/image/large",
      sourceUrl: TRACK_URL,
      provider: "spotify",
    });
  });

  test("resolves through the Web API and never fetches the public page", async () => {
    const calls: string[] = [];
    const provider = makeProvider({
      calls,
      handles: (url) =>
        url.endsWith("/v1/tracks/t1") ? jsonResponse(trackPayload("t1", "Song")) : undefined,
    });

    await provider.resolve(new URL(TRACK_URL));
    expect(calls.some((url) => url.includes("api.spotify.com"))).toBe(true);
    expect(calls.some((url) => url.startsWith("https://open.spotify.com/track/"))).toBe(false);
    expect(calls.some((url) => url.startsWith("https://open.spotify.com/oembed"))).toBe(false);
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

    const resolved = await provider.resolve(new URL(TRACK_URL));
    expect(resolved.tracks[0]?.youtubeVideoId).toBe("fast1234567");
    expect(calls.some((url) => url.includes("/v1/tracks/"))).toBe(false);
  });
});

describe("spotify provider without credentials", () => {
  test("scrapes the track page instead of calling any API", async () => {
    const calls: string[] = [];
    const provider = makeProvider({
      credentials: false,
      calls,
      handles: (url) =>
        url === TRACK_URL
          ? htmlResponse(
              ogPage({
                title: "Blinding Lights",
                description: "The Weeknd · After Hours · Song · 2020",
                type: "music.song",
                image: "https://i.scdn.co/image/abc",
                duration: "200",
              }),
            )
          : undefined,
    });

    const resolved = await provider.resolve(new URL(TRACK_URL));
    expect(resolved.tracks[0]).toEqual({
      title: "Blinding Lights",
      artists: ["The Weeknd"],
      durationSec: 200,
      thumbnailUrl: "https://i.scdn.co/image/abc",
      sourceUrl: TRACK_URL,
      provider: "spotify",
    });
    // No token, no Web API, no deprecated song.link call.
    expect(calls).toEqual([TRACK_URL]);
  });

  test("never invents a YouTube video id for a scraped track", async () => {
    const provider = makeProvider({
      credentials: false,
      calls: [],
      handles: () => htmlResponse(ogPage({ title: "Song", type: "music.song" })),
    });

    const resolved = await provider.resolve(new URL(TRACK_URL));
    expect(resolved.tracks[0]?.youtubeVideoId).toBeUndefined();
  });

  test("falls back to oEmbed when the page carries no title", async () => {
    const calls: string[] = [];
    const provider = makeProvider({
      credentials: false,
      calls,
      handles: (url) => {
        if (url === TRACK_URL) return htmlResponse("<html><head></head><body>shell</body></html>");
        if (url === OEMBED_URL) {
          return jsonResponse({
            title: "Oembed Song",
            thumbnail_url: "https://i.scdn.co/image/oembed",
          });
        }
        return undefined;
      },
    });

    const resolved = await provider.resolve(new URL(TRACK_URL));
    expect(resolved.tracks[0]).toEqual({
      title: "Oembed Song",
      artists: [],
      durationSec: null,
      thumbnailUrl: "https://i.scdn.co/image/oembed",
      sourceUrl: TRACK_URL,
      provider: "spotify",
    });
    expect(calls).toEqual([TRACK_URL, OEMBED_URL]);
  });

  test("falls back to oEmbed when the page request is not a 200", async () => {
    const provider = makeProvider({
      credentials: false,
      calls: [],
      handles: (url) => {
        if (url === OEMBED_URL) return jsonResponse({ title: "Oembed Song" });
        return htmlResponse("denied", 403);
      },
    });

    const resolved = await provider.resolve(new URL(TRACK_URL));
    expect(resolved.tracks[0]?.title).toBe("Oembed Song");
    expect(resolved.tracks[0]?.artists).toEqual([]);
    expect(resolved.tracks[0]?.thumbnailUrl).toBeNull();
  });

  test("scrape and oEmbed both failing is PROVIDER_UNAVAILABLE", async () => {
    const provider = makeProvider({ credentials: false, calls: [], handles: () => undefined });
    const error = await provider.resolve(new URL(TRACK_URL)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MusicLinkError);
    expect((error as MusicLinkError).code).toBe("PROVIDER_UNAVAILABLE");
    expect((error as MusicLinkError).message).toBe(SPOTIFY_UNREADABLE_MESSAGE);
  });

  test("a track page that reports an album is a collection: credentials required", async () => {
    const provider = makeProvider({
      credentials: false,
      calls: [],
      handles: () =>
        htmlResponse(
          ogPage({
            title: "The Album",
            description: "Artist · The Album · Song · 2020",
            type: "music.album",
          }),
        ),
    });

    const error = await provider.resolve(new URL(TRACK_URL)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MusicLinkError);
    expect((error as MusicLinkError).code).toBe("PROVIDER_AUTH_REQUIRED");
    expect((error as MusicLinkError).message).toBe(MISSING_CREDENTIALS_MESSAGE);
    expect((error as MusicLinkError).message).toContain("Premium");
    expect((error as MusicLinkError).message).toContain("track");
  });

  test("a collection without credentials fails before any network call", async () => {
    const calls: string[] = [];
    const provider = makeProvider({ credentials: false, calls, handles: () => undefined });

    const error = await provider
      .resolve(new URL("https://open.spotify.com/album/a1"))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MusicLinkError);
    expect((error as MusicLinkError).code).toBe("PROVIDER_AUTH_REQUIRED");
    expect((error as MusicLinkError).message).toBe(MISSING_CREDENTIALS_MESSAGE);
    expect(calls).toEqual([]);
  });
});
