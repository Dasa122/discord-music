import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommonArgs, type YtdlpOptions } from "./ytdlp.js";

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
