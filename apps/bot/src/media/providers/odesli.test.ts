import { describe, expect, test } from "bun:test";
import { OdesliClient, parseOdesliPayload } from "./odesli.js";
import { MusicLinkError } from "./types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const payload = {
  entityUniqueId: "SPOTIFY_SONG::abc",
  entitiesByUniqueId: {
    "SPOTIFY_SONG::abc": {
      id: "abc",
      type: "song",
      title: "Source Song",
      artistName: "Artist One, Artist Two",
      thumbnailUrl: "https://i.scdn.co/image/source",
    },
    "YOUTUBE::dQw4w9WgXcQ": {
      id: "dQw4w9WgXcQ",
      type: "song",
      title: "A different YouTube title",
      artistName: "Some Channel",
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg",
    },
  },
  linksByPlatform: {
    spotify: {
      url: "https://open.spotify.com/track/abc",
      entityUniqueId: "SPOTIFY_SONG::abc",
    },
    youtube: {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      entityUniqueId: "YOUTUBE::dQw4w9WgXcQ",
    },
  },
};

describe("odesli mapping", () => {
  test("keeps the source entity metadata and takes the youtube id from linksByPlatform", () => {
    expect(parseOdesliPayload(payload)).toEqual({
      title: "Source Song",
      artists: ["Artist One", "Artist Two"],
      thumbnailUrl: "https://i.scdn.co/image/source",
      youtubeVideoId: "dQw4w9WgXcQ",
    });
  });

  test("a payload without a youtube link still maps metadata", () => {
    const withoutYoutube = {
      ...payload,
      linksByPlatform: {
        spotify: payload.linksByPlatform.spotify,
      },
    };
    expect(parseOdesliPayload(withoutYoutube)).toEqual({
      title: "Source Song",
      artists: ["Artist One", "Artist Two"],
      thumbnailUrl: "https://i.scdn.co/image/source",
      youtubeVideoId: null,
    });
  });

  test("youtubeMusic links count as a youtube match", () => {
    const music = {
      ...payload,
      linksByPlatform: {
        youtubeMusic: { url: "https://music.youtube.com/watch?v=dQw4w9WgXcQ" },
      },
    };
    expect(parseOdesliPayload(music).youtubeVideoId).toBe("dQw4w9WgXcQ");
  });

  test("a payload without usable metadata is a typed failure", () => {
    expect(() => parseOdesliPayload({})).toThrow(MusicLinkError);
  });

  test("404 is TRACK_NOT_FOUND", async () => {
    const client = new OdesliClient({ fetch: async () => jsonResponse({}, 404) });
    const error = await client
      .lookup("https://open.spotify.com/track/abc")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MusicLinkError);
    expect((error as MusicLinkError).code).toBe("TRACK_NOT_FOUND");
  });

  test("429 is PROVIDER_RATE_LIMITED", async () => {
    const client = new OdesliClient({ fetch: async () => jsonResponse({}, 429) });
    const error = await client
      .lookup("https://open.spotify.com/track/abc")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MusicLinkError);
    expect((error as MusicLinkError).code).toBe("PROVIDER_RATE_LIMITED");
  });

  test("a network failure is PROVIDER_UNAVAILABLE, never an untyped crash", async () => {
    const client = new OdesliClient({
      fetch: async () => {
        throw new Error("offline");
      },
    });
    const error = await client
      .lookup("https://open.spotify.com/track/abc")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MusicLinkError);
    expect((error as MusicLinkError).code).toBe("PROVIDER_UNAVAILABLE");
  });
});
