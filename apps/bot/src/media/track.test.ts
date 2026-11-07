import { describe, expect, test } from "bun:test";
import type { QueueTrack } from "@music/shared";
import { enrichTrack, hostMatches, titleLooksUnresolved, toQueueTrack } from "./track.js";

function track(overrides: Partial<QueueTrack> = {}): QueueTrack {
  return {
    id: "vid",
    title: "A real title",
    url: "https://www.youtube.com/watch?v=vid",
    durationSec: 30,
    thumbnailUrl: null,
    source: "youtube",
    requestedBy: { id: "1", name: "Ada" },
    ...overrides,
  };
}

function sourceOf(webpageUrl: string, videoId: string | null = null) {
  return toQueueTrack(
    {
      videoId,
      title: "A title",
      webpageUrl,
      durationSec: 30,
      thumbnailUrl: null,
      isPlaylist: false,
    },
    { id: "1", name: "Ada" },
  ).source;
}

describe("hostMatches", () => {
  test("matches the domain itself and its subdomains only", () => {
    expect(hostMatches("youtube.com", "youtube.com")).toBe(true);
    expect(hostMatches("www.youtube.com", "youtube.com")).toBe(true);
    expect(hostMatches("notyoutube.com", "youtube.com")).toBe(false);
    expect(hostMatches("youtube.com.attacker.tld", "youtube.com")).toBe(false);
    expect(hostMatches("", "youtube.com")).toBe(false);
  });
});

describe("sourceFor", () => {
  test("classifies youtube.com, its subdomains and youtu.be as youtube", () => {
    for (const url of [
      "https://youtube.com/watch?v=x",
      "https://www.youtube.com/watch?v=x",
      "https://music.youtube.com/watch?v=x",
      "https://m.youtube.com/watch?v=x",
      "https://youtu.be/x",
    ]) {
      expect(sourceOf(url)).toBe("youtube");
    }
  });

  test("does not classify look-alike hosts as youtube", () => {
    for (const url of [
      "https://evil.com/youtube.com",
      "https://evil.com/?u=https://youtube.com/watch?v=x",
      "https://youtube.com.evil.tld",
      "https://notyoutube.com/x",
      "https://youtu.be.evil.tld/x",
    ]) {
      expect(sourceOf(url)).toBe("unknown");
    }
  });

  test("classifies direct media by pathname extension", () => {
    expect(sourceOf("https://cdn.example.com/a.mp3")).toBe("direct");
    expect(sourceOf("https://cdn.example.com/a.FLAC?token=1")).toBe("direct");
    expect(sourceOf("https://cdn.example.com/a.opus#t=10")).toBe("direct");
  });

  test("does not treat a media extension outside the pathname as direct", () => {
    expect(sourceOf("https://evil.com/page?x=.mp3")).toBe("unknown");
    expect(sourceOf("https://evil.com/a.mp3/extra")).toBe("unknown");
  });

  test("returns unknown for malformed URLs instead of throwing", () => {
    for (const url of ["not a url", "", "//youtube.com"]) {
      expect(sourceOf(url)).toBe("unknown");
    }
  });

  test("treats a resolved video id as authoritative", () => {
    expect(sourceOf("https://example.com/x", "vid")).toBe("youtube");
  });

  // The trailing dot is the absolute-DNS spelling of the same name, so it is
  // normalised away rather than treated as a look-alike.
  test("treats a trailing-dot host as the same host", () => {
    expect(sourceOf("https://youtube.com./watch")).toBe("youtube");
  });
});

describe("titleLooksUnresolved", () => {
  test("recognises paste-shaped titles", () => {
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    expect(titleLooksUnresolved("", url)).toBe(true);
    expect(titleLooksUnresolved(url, url)).toBe(true);
    expect(titleLooksUnresolved("https://youtu.be/dQw4w9WgXcQ", url)).toBe(true);
    expect(titleLooksUnresolved("dQw4w9WgXcQ", url)).toBe(true);
  });

  test("accepts a resolved title", () => {
    expect(
      titleLooksUnresolved("Never Gonna Give You Up", "https://www.youtube.com/watch?v=abc"),
    ).toBe(false);
    expect(titleLooksUnresolved("lofi", "https://www.youtube.com/watch?v=abcdefghij")).toBe(false);
  });
});

describe("enrichTrack", () => {
  const info = {
    videoId: "vid",
    title: "Authoritative Title",
    durationSec: 213.5,
    thumbnailUrl: "https://i.ytimg.com/vi/vid/hqdefault.jpg",
  };

  test("does not overwrite a good title", () => {
    const queued = track({ title: "A real title" });
    enrichTrack(queued, info);
    expect(queued.title).toBe("A real title");
  });

  test("replaces a raw id/URL title and fills missing fields", () => {
    const queued = track({
      title: "https://www.youtube.com/watch?v=vid",
      durationSec: null,
      thumbnailUrl: null,
    });

    expect(enrichTrack(queued, info)).toBe(true);
    expect(queued.title).toBe("Authoritative Title");
    expect(queued.durationSec).toBe(214);
    expect(queued.thumbnailUrl).toBe(info.thumbnailUrl);
  });

  test("keeps a known duration", () => {
    const queued = track({ durationSec: 30 });
    enrichTrack(queued, info);
    expect(queued.durationSec).toBe(30);
  });

  test("a null/empty info is a no-op", () => {
    const queued = track({ title: "https://example.com/x", durationSec: null });
    expect(enrichTrack(queued, null)).toBe(false);
    expect(queued.title).toBe("https://example.com/x");
    expect(queued.durationSec).toBeNull();
  });
});
