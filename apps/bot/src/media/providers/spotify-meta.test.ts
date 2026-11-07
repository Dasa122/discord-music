import { describe, expect, test } from "bun:test";
import {
  capHtmlBytes,
  decodeHtmlEntities,
  parseSpotifyArtists,
  parseSpotifyPage,
  SPOTIFY_PAGE_MAX_BYTES,
  sanitizeSpotifyHtml,
  stripScriptBlocks,
} from "./spotify-meta.js";

const TRACK_URL = "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b";

function page(head: string, body = ""): string {
  return `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`;
}

function meta(property: string, content: string): string {
  return `<meta property="${property}" content="${content}"/>`;
}

const MODERN_PAGE = page(
  [
    meta("og:site_name", "Spotify"),
    meta("og:title", "Blinding Lights"),
    meta("og:description", "The Weeknd · After Hours · Song · 2020"),
    meta("og:type", "music.song"),
    meta("og:image", "https://i.scdn.co/image/ab67616d0000b2738863bc11d2aa12b54f5aeb36"),
    meta("og:url", TRACK_URL),
    '<meta name="music:duration" content="200"/>',
    '<meta name="music:album" content="https://open.spotify.com/album/4yP0"/>',
  ].join("\n"),
  '<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>',
);

describe("spotify page meta parser", () => {
  test("parses a modern track page", () => {
    expect(parseSpotifyPage(MODERN_PAGE, TRACK_URL)).toEqual({
      kind: "track",
      ogType: "music.song",
      title: "Blinding Lights",
      artists: ["The Weeknd"],
      durationSec: 200,
      thumbnailUrl: "https://i.scdn.co/image/ab67616d0000b2738863bc11d2aa12b54f5aeb36",
      sourceUrl: TRACK_URL,
    });
  });

  test("og:type music.song is a track, music.album and music.playlist are collections", () => {
    expect(parseSpotifyPage(page(meta("og:type", "music.song")), TRACK_URL)?.kind).toBe("track");
    expect(parseSpotifyPage(page(meta("og:type", "music.album")), TRACK_URL)?.kind).toBe(
      "collection",
    );
    expect(parseSpotifyPage(page(meta("og:type", "music.playlist")), TRACK_URL)?.kind).toBe(
      "collection",
    );
  });

  test("a missing og:type leaves the kind unknown but keeps the title", () => {
    const parsed = parseSpotifyPage(page(meta("og:title", "Song")), TRACK_URL);
    expect(parsed?.kind).toBeNull();
    expect(parsed?.ogType).toBeNull();
    expect(parsed?.title).toBe("Song");
  });

  test("multi-artist descriptions split the first segment on commas", () => {
    const parsed = parseSpotifyPage(
      page(
        `${meta("og:title", "Sunflower")}${meta(
          "og:description",
          "Post Malone, Swae Lee · Spider-Man · Song · 2018",
        )}`,
      ),
      TRACK_URL,
    );
    expect(parsed?.artists).toEqual(["Post Malone", "Swae Lee"]);
  });

  test("commas inside the artist segment are separators, later · segments are ignored", () => {
    expect(parseSpotifyArtists("Earth, Wind & Fire · Album · Song · 1978")).toEqual([
      "Earth",
      "Wind & Fire",
    ]);
    expect(parseSpotifyArtists("A, B, C")).toEqual(["A", "B", "C"]);
    expect(parseSpotifyArtists("Solo Artist · Album")).toEqual(["Solo Artist"]);
    expect(parseSpotifyArtists(null)).toEqual([]);
  });

  test("a missing og:image yields no thumbnail", () => {
    const parsed = parseSpotifyPage(page(meta("og:title", "Song")), TRACK_URL);
    expect(parsed?.thumbnailUrl).toBeNull();
  });

  test("a missing music:duration yields null", () => {
    const parsed = parseSpotifyPage(page(meta("og:title", "Song")), TRACK_URL);
    expect(parsed?.durationSec).toBeNull();
  });

  test("decodes HTML entities in titles and descriptions", () => {
    const parsed = parseSpotifyPage(
      page(
        [
          meta("og:title", "Tom &amp; Jerry &#39;90 &quot;Mix&quot;"),
          meta("og:description", "Simon &amp; Garfunkel · Album"),
        ].join(""),
      ),
      TRACK_URL,
    );
    expect(parsed?.title).toBe(`Tom & Jerry '90 "Mix"`);
    expect(parsed?.artists).toEqual(["Simon & Garfunkel"]);
  });

  test("og:url falls back to the requested URL and rejects non-http values", () => {
    expect(parseSpotifyPage(page(meta("og:title", "Song")), TRACK_URL)?.sourceUrl).toBe(TRACK_URL);
    const evil = parseSpotifyPage(
      page(`${meta("og:title", "Song")}${meta("og:url", "javascript:alert(1)")}`),
      TRACK_URL,
    );
    expect(evil?.sourceUrl).toBe(TRACK_URL);
  });

  test("a generic web-player shell without tags parses to null", () => {
    const shell = page('<meta property="og:site_name" content="Spotify"/>');
    expect(parseSpotifyPage(shell, TRACK_URL)).toBeNull();
  });
});

describe("html sanitising", () => {
  test("decodes named, decimal and hex entities", () => {
    expect(decodeHtmlEntities("A &amp; B &#39;c&#39; &quot;d&quot;")).toBe(`A & B 'c' "d"`);
    expect(decodeHtmlEntities("&#x27;quoted&#x27;")).toBe("'quoted'");
    expect(decodeHtmlEntities("&unknown; stays")).toBe("&unknown; stays");
  });

  test("strips script blocks, including fake og tags inside them", () => {
    const html = page(
      `${meta("og:title", "Real")}<script>var x = '<meta property="og:title" content="Fake"/>';</script>`,
    );
    expect(stripScriptBlocks(html)).not.toContain("Fake");
    expect(parseSpotifyPage(html, TRACK_URL)?.title).toBe("Real");
  });

  test("strips end tags with trailing junk and nested constructs until stable", () => {
    expect(stripScriptBlocks("<script>one</script\t\n bar>tail")).toBe("tail");
    expect(stripScriptBlocks("<scr<script>ipt>alert(1)</script>").toLowerCase()).not.toContain(
      "<script",
    );
  });

  test("caps the body at 512 KB", () => {
    expect(SPOTIFY_PAGE_MAX_BYTES).toBe(512 * 1024);
    const huge = "x".repeat(SPOTIFY_PAGE_MAX_BYTES + 10_000);
    expect(Buffer.byteLength(capHtmlBytes(huge), "utf8")).toBeLessThanOrEqual(
      SPOTIFY_PAGE_MAX_BYTES,
    );
  });

  test("a tag beyond the cap is never parsed", () => {
    const filler = `<meta property="og:title" content="Before"/>${"x".repeat(
      SPOTIFY_PAGE_MAX_BYTES,
    )}${meta("og:title", "After")}`;
    const parsed = parseSpotifyPage(page(filler), TRACK_URL);
    expect(parsed?.title).toBe("Before");
    expect(sanitizeSpotifyHtml(page(filler))).not.toContain("After");
  });
});
