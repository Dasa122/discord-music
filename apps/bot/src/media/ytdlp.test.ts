import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCommonArgs,
  buildResolveArgs,
  MAX_EXTRACTION_STDOUT_BYTES,
  MAX_PLAYLIST_ENTRIES,
  stdoutExceedsLimit,
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
