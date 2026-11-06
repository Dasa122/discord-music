import { describe, expect, test } from "bun:test";
import { MediaError } from "../errors.js";
import {
  assertSafeMediaQuery,
  hasAllowedMediaExtension,
  isAllowedMediaHost,
  isPrivateAddress,
} from "./url-guard.js";

function resolverFor(...addresses: string[]) {
  return async (): Promise<string[]> => addresses;
}

function failingResolver() {
  return async (): Promise<string[]> => {
    throw new Error("ENOTFOUND");
  };
}

const PUBLIC_V4 = "142.250.72.14";

describe("assertSafeMediaQuery allow-list", () => {
  test("allows YouTube and its asset hosts", async () => {
    const allowed = [
      "https://www.youtube.com/watch?v=abc",
      "https://music.youtube.com/watch?v=abc",
      "https://youtu.be/abc",
      "https://www.youtube-nocookie.com/embed/abc",
      "https://rr3---sn-abc.googlevideo.com/videoplayback?id=1",
      "https://i.ytimg.com/vi/abc/hqdefault.jpg",
    ];

    for (const value of allowed) {
      await expect(
        assertSafeMediaQuery(value, { resolveHost: resolverFor(PUBLIC_V4) }),
      ).resolves.toBe(value);
    }
  });

  test("allows direct media files on any public host, port 443 or none", async () => {
    const allowed = [
      "https://cdn.example.net/song.mp3",
      "https://cdn.example.net/a/b.opus?token=1",
      "https://cdn.example.net:443/song.m4a",
      "https://cdn.example.net/song.MP4",
      "https://cdn.example.net/song.webm",
      "https://cdn.example.net/song.aac",
      "https://cdn.example.net/song.flac",
      "https://cdn.example.net/song.wav",
      "https://cdn.example.net/song.ogg",
      "https://93.184.216.34/song.mp3",
    ];

    for (const value of allowed) {
      await expect(
        assertSafeMediaQuery(value, { resolveHost: resolverFor(PUBLIC_V4) }),
      ).resolves.toBe(value);
    }
  });

  test("allows bare text and ytsearch queries", async () => {
    await expect(assertSafeMediaQuery("never gonna give you up")).resolves.toBe(
      "never gonna give you up",
    );
    await expect(assertSafeMediaQuery("ytsearch:some song")).resolves.toBe("ytsearch:some song");
    await expect(assertSafeMediaQuery("  ytsearch5:lofi  ")).resolves.toBe("ytsearch5:lofi");
  });

  test("rejects public hosts that are neither known media hosts nor media files", async () => {
    for (const value of [
      "https://example.com/watch?v=abc",
      "https://example.com/index.html",
      "https://example.com/song.mp3.exe",
      "https://example.com/song",
    ]) {
      await expect(assertSafeMediaQuery(value)).rejects.toBeInstanceOf(MediaError);
    }
  });

  test("rejects look-alike hosts", async () => {
    for (const value of [
      "https://youtube.com.evil.example/watch?v=abc",
      "https://evil-youtube.com/watch?v=abc",
      "https://notyoutu.be/abc",
      "https://googlevideo.com.evil.example/videoplayback",
    ]) {
      await expect(assertSafeMediaQuery(value)).rejects.toBeInstanceOf(MediaError);
    }
  });

  test("rejects non-443 ports even for a media file", async () => {
    for (const value of [
      "https://cdn.example.net:8443/song.mp3",
      "https://cdn.example.net:80/song.mp3",
    ]) {
      await expect(assertSafeMediaQuery(value)).rejects.toBeInstanceOf(MediaError);
    }
  });

  test("rejects non-https schemes", async () => {
    for (const value of [
      "http://example.com/a",
      "http://cdn.example.net/song.mp3",
      "file:///etc/passwd",
      "ftp://example.com/a",
    ]) {
      await expect(assertSafeMediaQuery(value)).rejects.toBeInstanceOf(MediaError);
    }
  });

  test("rejects literal loopback and private addresses without DNS", async () => {
    const literals = [
      "https://127.0.0.1/a",
      "https://127.0.0.1/song.mp3",
      "https://10.0.0.5/a.mp3",
      "https://172.16.0.1/a.mp3",
      "https://172.31.255.255/a.mp3",
      "https://192.168.1.10/a.mp3",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/a.mp3",
      "https://[fc00::1]/a.mp3",
      "https://[fd12:3456::1]/a.mp3",
      "https://[fe80::1]/a.mp3",
    ];

    for (const value of literals) {
      await expect(
        assertSafeMediaQuery(value, { resolveHost: failingResolver() }),
      ).rejects.toBeInstanceOf(MediaError);
    }
  });

  test("rejects an allow-listed host that resolves to a private address", async () => {
    await expect(
      assertSafeMediaQuery("https://www.youtube.com/watch?v=abc", {
        resolveHost: resolverFor("10.1.2.3"),
      }),
    ).rejects.toBeInstanceOf(MediaError);
  });

  test("rejects a media file host that resolves to a private address", async () => {
    await expect(
      assertSafeMediaQuery("https://cdn.example.net/song.mp3", {
        resolveHost: resolverFor("192.168.0.2"),
      }),
    ).rejects.toBeInstanceOf(MediaError);
  });

  test("rejects when any DNS answer is private", async () => {
    await expect(
      assertSafeMediaQuery("https://cdn.example.net/song.mp3", {
        resolveHost: resolverFor("93.184.216.34", "192.168.0.2"),
      }),
    ).rejects.toBeInstanceOf(MediaError);
  });

  test("rejects an unresolvable host", async () => {
    await expect(
      assertSafeMediaQuery("https://cdn.example.net/song.mp3", {
        resolveHost: failingResolver(),
      }),
    ).rejects.toBeInstanceOf(MediaError);
  });
});

describe("isAllowedMediaHost", () => {
  test("accepts the documented hosts and their subdomains", () => {
    expect(isAllowedMediaHost("youtube.com")).toBe(true);
    expect(isAllowedMediaHost("WWW.YouTube.com")).toBe(true);
    expect(isAllowedMediaHost("youtu.be")).toBe(true);
    expect(isAllowedMediaHost("www.youtube-nocookie.com")).toBe(true);
    expect(isAllowedMediaHost("rr1---sn.googlevideo.com")).toBe(true);
    expect(isAllowedMediaHost("i.ytimg.com")).toBe(true);
  });

  test("rejects hosts that merely contain an allowed name", () => {
    expect(isAllowedMediaHost("youtube.com.evil.example")).toBe(false);
    expect(isAllowedMediaHost("evil-youtube.com")).toBe(false);
    expect(isAllowedMediaHost("notyoutu.be")).toBe(false);
    expect(isAllowedMediaHost("example.com")).toBe(false);
  });
});

describe("hasAllowedMediaExtension", () => {
  test("matches the documented extensions case-insensitively", () => {
    expect(hasAllowedMediaExtension("/a/b.mp3")).toBe(true);
    expect(hasAllowedMediaExtension("/a/B.M4A")).toBe(true);
    expect(hasAllowedMediaExtension("/a/b.opus")).toBe(true);
    expect(hasAllowedMediaExtension("/a/b.ogg")).toBe(true);
    expect(hasAllowedMediaExtension("/a/b.webm")).toBe(true);
    expect(hasAllowedMediaExtension("/a/b.mp4")).toBe(true);
    expect(hasAllowedMediaExtension("/a/b.aac")).toBe(true);
    expect(hasAllowedMediaExtension("/a/b.flac")).toBe(true);
    expect(hasAllowedMediaExtension("/a/b.wav")).toBe(true);
  });

  test("rejects everything else", () => {
    expect(hasAllowedMediaExtension("/a/b.exe")).toBe(false);
    expect(hasAllowedMediaExtension("/a/b.mp3.exe")).toBe(false);
    expect(hasAllowedMediaExtension("/a/b")).toBe(false);
    expect(hasAllowedMediaExtension("/a/b.mp3/extra")).toBe(false);
  });
});

describe("isPrivateAddress", () => {
  test("classifies the documented ranges", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.1.1.1")).toBe(true);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("169.254.0.1")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isPrivateAddress("fc00::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });
});
