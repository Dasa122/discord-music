import { describe, expect, test } from "bun:test";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  buildCommonArgs,
  buildDownloadArgs,
  buildResolveArgs,
  buildSearchArgs,
  downloadAudio,
  MAX_EXTRACTION_STDOUT_BYTES,
  MAX_PLAYLIST_ENTRIES,
  parseProgressLine,
  parseTrackInfo,
  stdoutExceedsLimit,
  thumbnailFromVideoId,
  type YtdlpOptions,
} from "./ytdlp.js";

function baseOptions(overrides: Partial<YtdlpOptions> = {}): YtdlpOptions {
  return {
    path: "/usr/local/bin/yt-dlp",
    denoPath: "/usr/local/bin/deno",
    ...overrides,
  };
}

describe("buildCommonArgs", () => {
  test("always pins the Deno JS runtime", () => {
    const args = buildCommonArgs(baseOptions());
    expect(args).toContain("--js-runtimes");
    expect(args).toContain("deno:/usr/local/bin/deno");
    expect(args).toContain("--no-playlist");
    expect(args).toContain("--no-progress");
    expect(args).toContain("--no-warnings");
  });

  test("only adds --cookies when the file exists", () => {
    const missing = buildCommonArgs(
      baseOptions({ cookiesFile: "/definitely/missing/cookies.txt" }),
    );
    expect(missing).not.toContain("--cookies");

    const directory = mkdtempSync(join(tmpdir(), "music-bot-test-"));
    const cookies = join(directory, "cookies.txt");
    try {
      writeFileSync(cookies, "# Netscape HTTP Cookie File\n");
      const args = buildCommonArgs(baseOptions({ cookiesFile: cookies }));
      expect(args).toContain("--cookies");
      expect(args).toContain(cookies);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("adds proxy and PO token provider args when configured", () => {
    const args = buildCommonArgs(
      baseOptions({
        proxy: "http://proxy.example:8080",
        potProviderUrl: "http://pot-provider:4416",
      }),
    );

    expect(args).toContain("--proxy");
    expect(args).toContain("http://proxy.example:8080");
    expect(args).toContain("--extractor-args");
    expect(args).toContain("youtubepot-bgutilhttp:base_url=http://pot-provider:4416");
  });

  test("omits optional flags by default", () => {
    const args = buildCommonArgs(baseOptions());
    expect(args).not.toContain("--cookies");
    expect(args).not.toContain("--proxy");
    expect(args).not.toContain("--extractor-args");
  });
});

describe("buildResolveArgs", () => {
  test("bounds playlist resolutions to 50 entries", () => {
    const args = buildResolveArgs("https://www.youtube.com/playlist?list=PL123", baseOptions());
    expect(args).toContain("--yes-playlist");
    expect(args).toContain("--flat-playlist");
    expect(args).toContain("--playlist-end");
    expect(args[args.indexOf("--playlist-end") + 1]).toBe(String(MAX_PLAYLIST_ENTRIES));
    expect(MAX_PLAYLIST_ENTRIES).toBe(50);
  });

  test("leaves single-track and search resolutions unbounded", () => {
    for (const target of ["https://youtu.be/abc", "ytsearch1:lofi"]) {
      const args = buildResolveArgs(target, baseOptions());
      expect(args).not.toContain("--yes-playlist");
      expect(args).not.toContain("--playlist-end");
    }
  });

  test("always terminates options before the target", () => {
    const args = buildResolveArgs("ytsearch1:lofi", baseOptions());
    expect(args[args.length - 1]).toBe("ytsearch1:lofi");
    expect(args[args.length - 2]).toBe("--");
  });

  test("a search uses a flat listing, so no per-result page extraction", () => {
    const args = buildResolveArgs("ytsearch1:lofi", baseOptions());
    expect(args).toContain("--flat-playlist");
  });

  test("a single video URL is not flat", () => {
    const args = buildResolveArgs("https://youtu.be/abc123", baseOptions());
    expect(args).not.toContain("--flat-playlist");
  });
});

describe("buildSearchArgs", () => {
  test("bounds the search and stays flat", () => {
    const args = buildSearchArgs("lofi", 3, baseOptions());
    expect(args).toContain("--flat-playlist");
    expect(args[args.length - 1]).toBe("ytsearch3:lofi");
    expect(args[args.length - 2]).toBe("--");
  });

  test("clamps the requested limit", () => {
    expect(
      buildSearchArgs("lofi", 99, baseOptions())[
        buildSearchArgs("lofi", 99, baseOptions()).length - 1
      ],
    ).toBe("ytsearch10:lofi");
  });
});

describe("buildCommonArgs cache dir", () => {
  test("passes --cache-dir when configured", () => {
    const args = buildCommonArgs(baseOptions({ cacheDir: "/tmp/yt-dlp-cache" }));
    expect(args[args.indexOf("--cache-dir") + 1]).toBe("/tmp/yt-dlp-cache");
  });

  test("omits --cache-dir when unset", () => {
    expect(buildCommonArgs(baseOptions())).not.toContain("--cache-dir");
  });
});

describe("thumbnailFromVideoId", () => {
  test("derives the static YouTube thumbnail", () => {
    expect(thumbnailFromVideoId("dQw4w9WgXcQ")).toBe(
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    );
  });

  test("rejects a missing or malformed id", () => {
    expect(thumbnailFromVideoId(null)).toBeNull();
    expect(thumbnailFromVideoId("")).toBeNull();
    expect(thumbnailFromVideoId("not a video id")).toBeNull();
  });
});

describe("parseTrackInfo", () => {
  test("reads the downloaded track's metadata", () => {
    const info = parseTrackInfo(
      JSON.stringify({
        id: "dQw4w9WgXcQ",
        title: "Never Gonna Give You Up",
        duration: 213.5,
        webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
    );

    expect(info?.videoId).toBe("dQw4w9WgXcQ");
    expect(info?.title).toBe("Never Gonna Give You Up");
    expect(info?.durationSec).toBe(213.5);
    expect(info?.thumbnailUrl).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  });

  test("ignores empty, garbage, and truncated output without throwing", () => {
    expect(parseTrackInfo("")).toBeNull();
    expect(parseTrackInfo("   \n\n")).toBeNull();
    expect(parseTrackInfo("not json")).toBeNull();
    expect(parseTrackInfo("{oops")).toBeNull();
    expect(parseTrackInfo('{"id": "abc"')).toBeNull();
  });

  test("keeps an explicit thumbnail when present", () => {
    const info = parseTrackInfo(
      JSON.stringify({ id: "abc", title: "x", thumbnail: "https://cdn.example/t.jpg" }),
    );
    expect(info?.thumbnailUrl).toBe("https://cdn.example/t.jpg");
  });
});

describe("download argv", () => {
  test("downloads and prints JSON in one pass through the cache dir", () => {
    const args = buildDownloadArgs(
      { id: "vid", url: "https://www.youtube.com/watch?v=vid", durationSec: 30 },
      "/tmp/audio",
      baseOptions({ cacheDir: "/tmp/yt-dlp-cache" }),
      1_000,
    );

    expect(args).toContain("--print-json");
    expect(args).toContain("--no-simulate");
    expect(args[args.indexOf("--cache-dir") + 1]).toBe("/tmp/yt-dlp-cache");
  });

  test("opts back into newline progress with a prefixed template", () => {
    const args = buildDownloadArgs(
      { id: "vid", url: "https://www.youtube.com/watch?v=vid", durationSec: 30 },
      "/tmp/audio",
      baseOptions(),
      1_000,
    );

    // `--no-progress` comes from the common args; `--progress` must win.
    expect(args.indexOf("--progress")).toBeGreaterThan(args.indexOf("--no-progress"));
    expect(args).toContain("--newline");
    expect(args[args.indexOf("--progress-template") + 1]).toBe(
      "dl:%(progress.downloaded_bytes)s/%(progress.total_bytes)s",
    );
  });
});

describe("parseProgressLine", () => {
  test("parses downloaded and total bytes", () => {
    expect(parseProgressLine("dl:123/456")).toEqual({ downloadedBytes: 123, totalBytes: 456 });
    expect(parseProgressLine("  dl:0/0")).toEqual({ downloadedBytes: 0, totalBytes: 0 });
  });

  test("an unknown total is null", () => {
    expect(parseProgressLine("dl:123/NA")).toEqual({ downloadedBytes: 123, totalBytes: null });
    expect(parseProgressLine("dl:123/None")).toEqual({ downloadedBytes: 123, totalBytes: null });
  });

  test("garbage is ignored", () => {
    expect(parseProgressLine("dl:abc/def")).toBeNull();
    expect(parseProgressLine("dl:123")).toBeNull();
    expect(parseProgressLine("dl:-1/456")).toBeNull();
    expect(parseProgressLine("not a progress line")).toBeNull();
    expect(parseProgressLine('{"id":"vid"}')).toBeNull();
  });
});

describe("download progress streaming", () => {
  test("reports progress without corrupting the info JSON", async () => {
    const directory = mkdtempSync(join(tmpdir(), "music-bot-progress-"));
    writeFileSync(join(directory, "vid.webm"), "audio");

    const spawnFn = (() => {
      const child = new EventEmitter() as unknown as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, { stdout, stderr, kill: () => true, exitCode: null });
      queueMicrotask(() => {
        stdout.write('dl:100/1000\ndl:500/1000\n{"id":"vid","title":"A track","duration":30}\n');
        stdout.end();
        child.emit("close", 0);
      });
      return child;
    }) as unknown as typeof spawn;

    const progress: Array<{ downloadedBytes: number; totalBytes: number | null }> = [];
    try {
      const result = await downloadAudio(
        { id: "vid", url: "https://www.youtube.com/watch?v=vid", durationSec: 30 },
        directory,
        { spawn: spawnFn, onProgress: (event) => progress.push(event) },
      );

      expect(result.path).toBe(join(directory, "vid.webm"));
      expect(result.info?.title).toBe("A track");
      expect(progress).toEqual([
        { downloadedBytes: 100, totalBytes: 1000 },
        { downloadedBytes: 500, totalBytes: 1000 },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("stdoutExceedsLimit", () => {
  test("the cap is 8 MiB and the boundary is exclusive", () => {
    expect(MAX_EXTRACTION_STDOUT_BYTES).toBe(8 * 1024 * 1024);
    expect(stdoutExceedsLimit(0)).toBe(false);
    expect(stdoutExceedsLimit(MAX_EXTRACTION_STDOUT_BYTES - 1)).toBe(false);
    expect(stdoutExceedsLimit(MAX_EXTRACTION_STDOUT_BYTES)).toBe(false);
    expect(stdoutExceedsLimit(MAX_EXTRACTION_STDOUT_BYTES + 1)).toBe(true);
  });

  test("accumulated multi-byte output is measured in bytes, not characters", () => {
    const emoji = Buffer.byteLength("🎵", "utf8");
    expect(emoji).toBe(4);
    // A whole number of emoji fills the cap exactly: allowed. One more byte is not.
    const emojiAtCap = MAX_EXTRACTION_STDOUT_BYTES / emoji;
    expect(stdoutExceedsLimit(emojiAtCap * emoji)).toBe(false);
    expect(stdoutExceedsLimit(emojiAtCap * emoji + 1)).toBe(true);
  });
});

describe("buildDownloadArgs", () => {
  test("includes the cache-specific flags and never a shell", async () => {
    const directory = mkdtempSync(join(tmpdir(), "music-bot-download-"));
    const cookies = join(directory, "cookies.txt");
    writeFileSync(cookies, "# Netscape HTTP Cookie File\n");

    let captured: { path: string; args: string[]; options: unknown } | null = null;
    const spawnFn = ((path: string, args: string[], options: unknown) => {
      captured = { path, args, options };
      const child = new EventEmitter() as unknown as ChildProcess;
      Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
        exitCode: null,
      });
      queueMicrotask(() => child.emit("error", new Error("spawn stopped for the test")));
      return child;
    }) as unknown as typeof spawn;

    try {
      await expect(
        downloadAudio(
          {
            id: "video123",
            url: "https://www.youtube.com/watch?v=video123",
            durationSec: 30,
          },
          directory,
          {
            spawn: spawnFn,
            maxBytes: 123_456,
            options: baseOptions({
              cookiesFile: cookies,
              proxy: "http://proxy.example:8080",
            }),
          },
        ),
      ).rejects.toThrow(/Could not start yt-dlp/);

      expect(captured?.path).toBe("/usr/local/bin/yt-dlp");
      expect(captured?.options).toMatchObject({ shell: false });
      const args = captured?.args ?? [];
      expect(args).toContain("--max-filesize");
      expect(args[args.indexOf("--max-filesize") + 1]).toBe("123456");
      expect(args).toContain("--js-runtimes");
      expect(args).toContain("deno:/usr/local/bin/deno");
      expect(args).toContain("--cookies");
      expect(args).toContain(cookies);
      expect(args).toContain("--proxy");
      expect(args).toContain("http://proxy.example:8080");
      expect(args).toContain("bestaudio[acodec=opus]/bestaudio/best");
      expect(args[args.indexOf("--output") + 1]).toBe(join(directory, "video123.%(ext)s"));
      expect(args[args.length - 1]).toBe("https://www.youtube.com/watch?v=video123");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses live or unknown-duration tracks before spawning", async () => {
    let spawned = 0;
    const spawnFn = (() => {
      spawned += 1;
      throw new Error("should not spawn");
    }) as unknown as typeof spawn;

    await expect(
      downloadAudio(
        { id: "a", url: "https://www.youtube.com/watch?v=a", durationSec: null },
        "/tmp/music-audio-test",
        { spawn: spawnFn },
      ),
    ).rejects.toThrow(/no known duration/);

    await expect(
      downloadAudio(
        { id: "b", url: "https://www.youtube.com/watch?v=b", durationSec: 10, isLive: true },
        "/tmp/music-audio-test",
        { spawn: spawnFn },
      ),
    ).rejects.toThrow(/Live streams/);

    expect(spawned).toBe(0);
  });
});
