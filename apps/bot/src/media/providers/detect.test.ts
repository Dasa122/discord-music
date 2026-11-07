import { describe, expect, test } from "bun:test";
import { detectMusicLink, parseMusicLink } from "./detect.js";

function detect(query: string) {
  const link = parseMusicLink(query);
  if (!link) return null;
  return { provider: link.provider, kind: link.kind, id: link.id };
}

describe("music link detection", () => {
  test("spotify tracks, albums and playlists", () => {
    expect(detect("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")).toEqual({
      provider: "spotify",
      kind: "track",
      id: "4uLU6hMCjMI75M1A2tKUQC",
    });
    expect(detect("https://open.spotify.com/album/1ATL5GLyefJaxhQzSPVrLX")).toEqual({
      provider: "spotify",
      kind: "album",
      id: "1ATL5GLyefJaxhQzSPVrLX",
    });
    expect(detect("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M")).toEqual({
      provider: "spotify",
      kind: "playlist",
      id: "37i9dQZF1DXcBWIGoYBM5M",
    });
  });

  test("spotify locale-prefixed links (intl-xx) and the bare domain", () => {
    expect(detect("https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC")).toEqual({
      provider: "spotify",
      kind: "track",
      id: "4uLU6hMCjMI75M1A2tKUQC",
    });
    expect(detect("https://spotify.com/track/abc123")).toEqual({
      provider: "spotify",
      kind: "track",
      id: "abc123",
    });
    expect(detect("https://open.spotify.com/intl-pt-BR/album/abc123")).toEqual({
      provider: "spotify",
      kind: "album",
      id: "abc123",
    });
  });

  test("apple music track (?i=), album and playlist", () => {
    expect(detect("https://music.apple.com/us/album/abbey-road/401186200?i=401186204")).toEqual({
      provider: "applemusic",
      kind: "track",
      id: "401186204",
    });

    expect(detect("https://music.apple.com/us/album/abbey-road/401186200")).toEqual({
      provider: "applemusic",
      kind: "album",
      id: "401186200",
    });

    expect(detect("https://music.apple.com/us/playlist/chill/pl.u-abc123")).toEqual({
      provider: "applemusic",
      kind: "playlist",
      id: "pl.u-abc123",
    });

    expect(detect("https://music.apple.com/album/abbey-road/401186200")).toEqual({
      provider: "applemusic",
      kind: "album",
      id: "401186200",
    });
  });

  test("youtube and arbitrary urls are never music links", () => {
    for (const query of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://example.com/track/abc123",
      "https://open.spotify.com.evil.example/track/abc123",
      "https://notspotify.com/track/abc123",
      "https://music.apple.com.evil.example/us/album/x/123",
      "never gonna give you up",
    ]) {
      expect(parseMusicLink(query)).toBeNull();
    }
  });

  test("malformed, incomplete and non-http links are null", () => {
    for (const query of [
      "",
      "not a url",
      "open.spotify.com/track/abc",
      "ftp://open.spotify.com/track/abc123",
      "https://open.spotify.com/",
      "https://open.spotify.com/track/",
      "https://open.spotify.com/episode/abc123",
      "https://music.apple.com/us/album/",
      "https://music.apple.com/us/",
    ]) {
      expect(parseMusicLink(query)).toBeNull();
    }
    // An empty `i` is not a track id: the link still means the album.
    expect(detect("https://music.apple.com/us/album/x/123?i=")).toEqual({
      provider: "applemusic",
      kind: "album",
      id: "123",
    });
  });

  test("detectMusicLink only matches http(s) URLs", () => {
    expect(detectMusicLink(new URL("https://open.spotify.com/track/abc123"))?.kind).toBe("track");
    expect(detectMusicLink(new URL("ftp://open.spotify.com/track/abc123"))).toBeNull();
    expect(detectMusicLink(new URL("https://example.com/track/abc123"))).toBeNull();
  });
});
