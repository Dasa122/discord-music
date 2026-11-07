import { describe, expect, test } from "bun:test";
import { createAppleMusicProvider, parseIsoDuration } from "./applemusic.js";
import { OdesliClient } from "./odesli.js";
import { type FetchLike, MusicLinkError } from "./types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(jsonLd: unknown): Response {
  const script = `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;
  return new Response(`<!doctype html><html><head>${script}</head><body></body></html>`, {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

const TRACK_URL = "https://music.apple.com/us/album/abbey-road/401186200?i=401186204";
const ALBUM_URL = "https://music.apple.com/us/album/abbey-road/401186200";
const PLAYLIST_URL = "https://music.apple.com/us/playlist/chill/pl.u-abc123";

const recording = {
  "@type": "MusicRecording",
  name: "Here Comes the Sun",
  duration: "PT3M42S",
  byArtist: { "@type": "MusicGroup", name: "The Beatles" },
  image: "https://is1.mzstatic.com/image/{w}x{h}.jpg",
  url: TRACK_URL,
};

function makeProvider(options: {
  calls: string[];
  handles: (url: string) => Response | undefined;
}) {
  const fetchFn: FetchLike = async (input) => {
    options.calls.push(input);
    return options.handles(input) ?? jsonResponse({}, 404);
  };
  return createAppleMusicProvider({
    odesli: new OdesliClient({ fetch: fetchFn }),
    fetch: fetchFn,
  });
}

describe("apple music json-ld", () => {
  test("maps a single MusicRecording and parses its ISO-8601 duration", async () => {
    const provider = makeProvider({
      calls: [],
      handles: (url) => (url === TRACK_URL ? htmlResponse(recording) : undefined),
    });

    const resolved = await provider.resolve(new URL(TRACK_URL));
    expect(resolved.kind).toBe("track");
    expect(resolved.tracks[0]).toEqual({
      title: "Here Comes the Sun",
      artists: ["The Beatles"],
      durationSec: 222,
      thumbnailUrl: "https://is1.mzstatic.com/image/512x512.jpg",
      sourceUrl: TRACK_URL,
      provider: "applemusic",
    });
  });

  test("maps a track page's MusicComposition wrapper", async () => {
    const provider = makeProvider({
      calls: [],
      handles: (url) =>
        url === TRACK_URL
          ? htmlResponse({
              "@type": "MusicComposition",
              name: "Come Together",
              url: "https://music.apple.com/us/song/come-together/1441164430",
              timeRequired: "PT4M18S",
              image: "https://is1.mzstatic.com/image/composition.jpg",
              audio: {
                "@type": "MusicRecording",
                duration: "PT4M18S",
                byArtist: [{ "@type": "MusicGroup", name: "The Beatles" }],
              },
            })
          : undefined,
    });

    const resolved = await provider.resolve(new URL(TRACK_URL));
    expect(resolved.tracks[0]).toEqual({
      title: "Come Together",
      artists: ["The Beatles"],
      durationSec: 258,
      thumbnailUrl: "https://is1.mzstatic.com/image/composition.jpg",
      sourceUrl: "https://music.apple.com/us/song/come-together/1441164430",
      provider: "applemusic",
    });
  });

  test("maps a MusicAlbum and every track in it", async () => {
    const calls: string[] = [];
    const provider = makeProvider({
      calls,
      handles: (url) =>
        url === ALBUM_URL
          ? htmlResponse({
              "@type": "MusicAlbum",
              name: "Abbey Road",
              byArtist: [{ "@type": "MusicGroup", name: "The Beatles" }],
              image: ["https://is1.mzstatic.com/image/album.jpg"],
              track: [
                { "@type": "MusicRecording", name: "Come Together", duration: "PT4M19S" },
                { "@type": "MusicRecording", name: "Something", duration: "PT1H2M3S" },
              ],
            })
          : undefined,
    });

    const resolved = await provider.resolve(new URL(ALBUM_URL));
    expect(resolved.kind).toBe("album");
    expect(resolved.title).toBe("Abbey Road");
    expect(resolved.tracks.map((track) => track.title)).toEqual(["Come Together", "Something"]);
    expect(resolved.tracks.map((track) => track.durationSec)).toEqual([259, 3_723]);
    expect(resolved.tracks[0]?.thumbnailUrl).toBe("https://is1.mzstatic.com/image/album.jpg");
    // Album-level artists fill in for tracks that do not repeat byArtist.
    expect(resolved.tracks.map((track) => track.artists)).toEqual([
      ["The Beatles"],
      ["The Beatles"],
    ]);
    // A collection never needs a song.link lookup.
    expect(calls.some((url) => url.startsWith("https://api.song.link/"))).toBe(false);
  });

  test("maps a MusicPlaylist", async () => {
    const provider = makeProvider({
      calls: [],
      handles: (url) =>
        url === PLAYLIST_URL
          ? htmlResponse({
              "@type": "MusicPlaylist",
              name: "Chill",
              track: [{ "@type": "MusicRecording", name: "Quiet Song", duration: "PT2M" }],
            })
          : undefined,
    });

    const resolved = await provider.resolve(new URL(PLAYLIST_URL));
    expect(resolved.kind).toBe("playlist");
    expect(resolved.title).toBe("Chill");
    expect(resolved.tracks[0]?.durationSec).toBe(120);
  });

  test("missing JSON-LD falls back to Odesli for a track", async () => {
    const provider = makeProvider({
      calls: [],
      handles: (url) => {
        if (url.startsWith("https://api.song.link/")) {
          return jsonResponse({
            entityUniqueId: "ITUNES_SONG::123",
            entitiesByUniqueId: {
              "ITUNES_SONG::123": {
                title: "Fallback Song",
                artistName: "Fallback Artist",
                thumbnailUrl: "https://is1.mzstatic.com/image/fallback.jpg",
              },
            },
            linksByPlatform: {
              spotify: { url: "https://open.spotify.com/track/x" },
            },
          });
        }
        return new Response("<html><head></head><body>No data</body></html>", { status: 200 });
      },
    });

    const resolved = await provider.resolve(new URL(TRACK_URL));
    expect(resolved.tracks[0]?.title).toBe("Fallback Song");
    expect(resolved.tracks[0]?.artists).toEqual(["Fallback Artist"]);
  });

  test("missing JSON-LD fails clearly for a collection", async () => {
    const provider = makeProvider({
      calls: [],
      handles: () => new Response("<html><body>No data</body></html>", { status: 200 }),
    });
    const error = await provider.resolve(new URL(ALBUM_URL)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MusicLinkError);
    expect((error as MusicLinkError).code).toBe("PROVIDER_UNAVAILABLE");
    expect((error as MusicLinkError).message).toContain("did not expose album metadata");
  });

  test("a 404 is TRACK_NOT_FOUND", async () => {
    const provider = makeProvider({
      calls: [],
      handles: (url) => (url === ALBUM_URL ? new Response("missing", { status: 404 }) : undefined),
    });
    const error = await provider.resolve(new URL(ALBUM_URL)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MusicLinkError);
    expect((error as MusicLinkError).code).toBe("TRACK_NOT_FOUND");
  });
});

describe("ISO-8601 durations", () => {
  test("parses minutes/seconds and hours/minutes/seconds", () => {
    expect(parseIsoDuration("PT3M42S")).toBe(222);
    expect(parseIsoDuration("PT1H2M3S")).toBe(3_723);
    expect(parseIsoDuration("PT45S")).toBe(45);
    expect(parseIsoDuration("P1DT1S")).toBe(86_401);
  });

  test("rejects garbage and null", () => {
    expect(parseIsoDuration(null)).toBeNull();
    expect(parseIsoDuration("")).toBeNull();
    expect(parseIsoDuration("3:42")).toBeNull();
  });
});
