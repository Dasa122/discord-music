import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { MediaError } from "../errors.js";
import { toCacheId } from "./audio-cache.js";
import { QueuedSemaphore } from "./limits.js";
import { assertSafeMediaQuery } from "./url-guard.js";

/** Hard limits for one metadata extraction. */
export const MAX_EXTRACTION_CONCURRENCY = 3;
export const EXTRACTION_WAIT_MS = 120_000;
export const MAX_EXTRACTION_STDOUT_BYTES = 8 * 1024 * 1024;
export const MAX_PLAYLIST_ENTRIES = 50;

/** Shared by `resolve` and `resolveSearch`; `openAudioStream` is a stream, not an extraction. */
export const extractionSemaphore = new QueuedSemaphore(
  MAX_EXTRACTION_CONCURRENCY,
  EXTRACTION_WAIT_MS,
);

/** True when accumulated yt-dlp stdout has crossed the 8 MB ceiling. */
export function stdoutExceedsLimit(byteLength: number): boolean {
  return byteLength > MAX_EXTRACTION_STDOUT_BYTES;
}

export interface YtdlpOptions {
  path: string;
  denoPath: string;
  cookiesFile?: string;
  proxy?: string;
  potProviderUrl?: string;
}

export interface ResolvedTrack {
  videoId: string | null;
  title: string;
  webpageUrl: string;
  durationSec: number | null;
  thumbnailUrl: string | null;
  isPlaylist: boolean;
  entries?: ResolvedTrack[];
}

export interface OpenAudioStreamOptions {
  startSec?: number;
  options?: YtdlpOptions;
  onError?: (error: MediaError) => void;
}

export interface OpenAudioStreamResult {
  process: ChildProcess;
  stream: Readable;
}

export function ytdlpOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): YtdlpOptions {
  return {
    path: env.YTDLP_PATH?.trim() || "yt-dlp",
    denoPath: env.DENO_PATH?.trim() || "deno",
    cookiesFile: env.YTDLP_COOKIES_FILE?.trim() || undefined,
    proxy: env.YTDLP_PROXY?.trim() || undefined,
    potProviderUrl: env.POT_PROVIDER_URL?.trim() || undefined,
  };
}

export function buildCommonArgs(options: YtdlpOptions = ytdlpOptionsFromEnv()): string[] {
  const args = [
    "--no-warnings",
    "--no-playlist",
    "--no-progress",
    "--js-runtimes",
    `deno:${options.denoPath}`,
  ];

  if (options.cookiesFile && existsSync(options.cookiesFile)) {
    args.push("--cookies", options.cookiesFile);
  }
  if (options.proxy) {
    args.push("--proxy", options.proxy);
  }
  if (options.potProviderUrl) {
    args.push("--extractor-args", `youtubepot-bgutilhttp:base_url=${options.potProviderUrl}`);
  }

  return args;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isPlaylistUrl(value: string): boolean {
  return isHttpUrl(value) && /(?:[?&]list=|\/playlist\/|\/sets\/)/i.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function thumbnailFrom(raw: Record<string, unknown>): string | null {
  const direct = stringValue(raw.thumbnail);
  if (direct) return direct;

  const thumbnails = raw.thumbnails;
  if (Array.isArray(thumbnails)) {
    for (let index = thumbnails.length - 1; index >= 0; index -= 1) {
      const entry = asRecord(thumbnails[index]);
      const url = entry ? stringValue(entry.url) : null;
      if (url) return url;
    }
  }
  return null;
}

function normalizeWebpageUrl(raw: Record<string, unknown>, videoId: string | null): string | null {
  const webpageUrl = stringValue(raw.webpage_url) ?? stringValue(raw.original_url);
  if (webpageUrl) return webpageUrl;

  const url = stringValue(raw.url);
  if (!url) return null;
  if (isHttpUrl(url)) return url;
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
}

function mapEntry(raw: unknown): ResolvedTrack | null {
  const record = asRecord(raw);
  if (!record) return null;

  const title = stringValue(record.title) ?? stringValue(record.fulltitle);
  if (!title) return null;

  const videoId = stringValue(record.id);
  const webpageUrl = normalizeWebpageUrl(record, videoId);
  if (!webpageUrl) return null;

  return {
    videoId,
    title,
    webpageUrl,
    durationSec: numberValue(record.duration),
    thumbnailUrl: thumbnailFrom(record),
    isPlaylist: false,
  };
}

function parseJsonOutput(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new MediaError("NOT_FOUND", "yt-dlp returned no output.");
  }

  const start = trimmed.indexOf("{");
  const candidate = start >= 0 ? trimmed.slice(start) : trimmed;
  try {
    const parsed = JSON.parse(candidate);
    const record = asRecord(parsed);
    if (!record) throw new Error("not an object");
    return record;
  } catch {
    throw new MediaError("EXTRACTOR_FAILED", "Could not parse yt-dlp output.");
  }
}

function lastStderrLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

function classifyFailure(stderr: string): "NOT_FOUND" | "EXTRACTOR_FAILED" {
  const text = stderr.toLowerCase();
  if (
    /not found|does not exist|unavailable|no video|no results|private video|removed by the uploader|404/.test(
      text,
    )
  ) {
    return "NOT_FOUND";
  }
  return "EXTRACTOR_FAILED";
}

function runYtdlp(args: string[], options: YtdlpOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.path, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderrLines: string[] = [];
    let stderrRemainder = "";
    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new MediaError("EXTRACTOR_FAILED", "yt-dlp timed out."));
    }, 90_000);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      stdout += chunk;
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (!stdoutExceedsLimit(stdoutBytes)) return;

      // Stop the extractor instead of buffering an unbounded playlist dump.
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(
        new MediaError(
          "OUTPUT_TOO_LARGE",
          "The extractor returned too much data. Try a more specific link.",
        ),
      );
    });
    child.stderr.on("data", (chunk: string) => {
      const parts = `${stderrRemainder}${chunk}`.split(/\r?\n/);
      stderrRemainder = parts.pop() ?? "";
      for (const part of parts) {
        if (part.trim()) stderrLines.push(part);
        if (stderrLines.length > 20) stderrLines.shift();
      }
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new MediaError(
          "SPAWN_FAILED",
          `Could not start yt-dlp at "${options.path}": ${error.message}`,
        ),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (stderrRemainder.trim()) stderrLines.push(stderrRemainder);
      const stderr = stderrLines.join("\n");

      if (code !== 0) {
        const kind = classifyFailure(stderr);
        const debug = (process.env.LOG_LEVEL ?? "").trim().toLowerCase() === "debug";
        const reason = debug ? lastStderrLine(stderr) : "";
        reject(
          new MediaError(
            kind,
            kind === "NOT_FOUND"
              ? "No playable result was found."
              : `yt-dlp failed${reason ? `: ${reason}` : "."} The extractor may be outdated.`,
            stderr,
          ),
        );
        return;
      }

      resolve(stdout);
    });
  });
}

/** Args for one metadata extraction; exported so the playlist bound is testable. */
export function buildResolveArgs(target: string, options: YtdlpOptions): string[] {
  const playlistRequest = isPlaylistUrl(target);
  return [
    ...buildCommonArgs(options),
    "--dump-single-json",
    ...(playlistRequest
      ? ["--yes-playlist", "--flat-playlist", "--playlist-end", String(MAX_PLAYLIST_ENTRIES)]
      : []),
    "--",
    target,
  ];
}

async function withExtractionSlot<T>(run: () => Promise<T>): Promise<T> {
  const release = await extractionSemaphore.acquire(
    () => new MediaError("EXTRACTION_BUSY", "The media extractor is busy. Try again in a moment."),
  );
  try {
    return await run();
  } finally {
    release();
  }
}

export async function resolve(
  query: string,
  options: YtdlpOptions = ytdlpOptionsFromEnv(),
): Promise<ResolvedTrack> {
  const trimmed = query.trim();
  if (!trimmed) throw new MediaError("NOT_FOUND", "The search query is empty.");

  const target = await assertSafeMediaQuery(trimmed);
  const playlistRequest = isPlaylistUrl(target);
  const ytdlpTarget = /^ytsearch\d*:/i.test(target)
    ? target
    : isHttpUrl(target)
      ? target
      : `ytsearch1:${target}`;
  const args = buildResolveArgs(ytdlpTarget, options);

  const stdout = await withExtractionSlot(() => runYtdlp(args, options));
  const raw = parseJsonOutput(stdout);
  const type = stringValue(raw._type);

  if (type === "playlist") {
    const entriesRaw = Array.isArray(raw.entries) ? raw.entries : [];
    const entries = entriesRaw
      .slice(0, MAX_PLAYLIST_ENTRIES)
      .map(mapEntry)
      .filter((entry): entry is ResolvedTrack => entry !== null);

    if (!playlistRequest) {
      const first = entries[0];
      if (!first) throw new MediaError("NOT_FOUND", "No playable result was found.");
      return first;
    }

    const title = stringValue(raw.title) ?? "Playlist";
    const webpageUrl = stringValue(raw.webpage_url) ?? target;
    return {
      videoId: stringValue(raw.id),
      title,
      webpageUrl,
      durationSec: null,
      thumbnailUrl: thumbnailFrom(raw),
      isPlaylist: true,
      entries,
    };
  }

  const single = mapEntry(raw);
  if (!single) throw new MediaError("NOT_FOUND", "No playable result was found.");
  return single;
}

export async function resolveSearch(
  query: string,
  limit: number,
  options: YtdlpOptions = ytdlpOptionsFromEnv(),
): Promise<ResolvedTrack[]> {
  const trimmed = query.trim();
  if (!trimmed) throw new MediaError("NOT_FOUND", "The search query is empty.");

  // The query is always wrapped in `ytsearchN:` below, but a scheme it would
  // never accept is still rejected here so both spawn paths share one gate.
  await assertSafeMediaQuery(trimmed);

  const bounded = Math.max(1, Math.min(10, Math.trunc(limit)));
  const args = [
    ...buildCommonArgs(options),
    "--dump-single-json",
    "--flat-playlist",
    "--",
    `ytsearch${bounded}:${trimmed}`,
  ];

  const stdout = await withExtractionSlot(() => runYtdlp(args, options));
  const raw = parseJsonOutput(stdout);
  const type = stringValue(raw._type);

  if (type === "playlist") {
    const entriesRaw = Array.isArray(raw.entries) ? raw.entries : [];
    return entriesRaw
      .slice(0, bounded)
      .map(mapEntry)
      .filter((entry): entry is ResolvedTrack => entry !== null)
      .slice(0, bounded);
  }

  const single = mapEntry(raw);
  return single ? [single] : [];
}

export async function openAudioStream(
  track: { url: string; title?: string },
  options: OpenAudioStreamOptions = {},
): Promise<OpenAudioStreamResult> {
  // Every path that reaches yt-dlp (searches, playlist rows, direct URLs) passes
  // through here, so the URL allow-list is enforced at the spawn point.
  await assertSafeMediaQuery(track.url);

  const ytdlpOptions = options.options ?? ytdlpOptionsFromEnv();
  const args = [...buildCommonArgs(ytdlpOptions), "-f", "bestaudio/best", "-o", "-"];

  const startSec = options.startSec ?? 0;
  if (startSec > 0) {
    args.push("--download-sections", `*${Math.floor(startSec)}-`);
  }
  args.push("--", track.url);

  const child = spawn(ytdlpOptions.path, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stderrLines: string[] = [];
  let stderrRemainder = "";
  let settled = false;

  const fail = (error: MediaError): void => {
    if (settled) return;
    settled = true;
    options.onError?.(error);
    child.stdout.destroy(error);
  };

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const parts = `${stderrRemainder}${chunk}`.split(/\r?\n/);
    stderrRemainder = parts.pop() ?? "";
    for (const part of parts) {
      if (part.trim()) stderrLines.push(part);
      if (stderrLines.length > 20) stderrLines.shift();
    }
  });

  child.on("error", (error) => {
    fail(
      new MediaError(
        "SPAWN_FAILED",
        `Could not start yt-dlp at "${ytdlpOptions.path}": ${error.message}`,
      ),
    );
  });

  child.on("close", (code) => {
    if (settled || code === 0) return;
    if (stderrRemainder.trim()) stderrLines.push(stderrRemainder);
    const stderr = stderrLines.join("\n");
    const kind = classifyFailure(stderr);
    fail(
      new MediaError(
        kind,
        kind === "NOT_FOUND"
          ? "The track is unavailable."
          : "yt-dlp stopped while streaming audio. The extractor may be outdated.",
        stderr,
      ),
    );
  });

  // Keep an error listener attached so a destroyed stdout never surfaces as an
  // unhandled stream error before the player attaches its own handler.
  child.stdout.on("error", () => {});
  child.stdout.on("close", () => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  return { process: child, stream: child.stdout };
}

export interface DownloadTrack {
  id?: string;
  videoId?: string | null;
  url: string;
  title?: string;
  durationSec?: number | null;
  isLive?: boolean;
}

export interface DownloadAudioOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  options?: YtdlpOptions;
  /** Injection point for tests; production always uses the real spawn. */
  spawn?: typeof spawn;
}

export const DEFAULT_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 300_000;

function downloadId(track: DownloadTrack): string {
  return toCacheId(track.videoId ?? track.id ?? track.url);
}

/** Args for one audio download; exported so the argv contract stays testable. */
export function buildDownloadArgs(
  track: DownloadTrack,
  destDir: string,
  options: YtdlpOptions,
  maxBytes: number,
): string[] {
  return [
    ...buildCommonArgs(options),
    "-f",
    "bestaudio[acodec=opus]/bestaudio/best",
    "--max-filesize",
    String(maxBytes),
    "--output",
    join(destDir, `${downloadId(track)}.%(ext)s`),
    "--",
    track.url,
  ];
}

async function removeLeftovers(destDir: string, id: string, keep?: string): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(destDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(`${id}.`)) continue;
    const path = join(destDir, name);
    if (path === keep) continue;
    try {
      await unlink(path);
    } catch {
      // Best effort cleanup.
    }
  }
}

/**
 * Download one track's audio into `destDir` and return the produced file.
 * The caller owns the file from that point (the cache atomically renames it).
 */
export async function downloadAudio(
  track: DownloadTrack,
  destDir: string,
  options: DownloadAudioOptions = {},
): Promise<string> {
  if (track.isLive) {
    throw new MediaError("DOWNLOAD_FAILED", "Live streams cannot be cached.");
  }
  if (track.durationSec === null || track.durationSec === undefined) {
    throw new MediaError("DOWNLOAD_FAILED", "The track has no known duration.");
  }

  await assertSafeMediaQuery(track.url);

  const signal = options.signal;
  if (signal?.aborted) {
    throw new MediaError("DOWNLOAD_ABORTED", "The download was cancelled.");
  }

  const ytdlpOptions = options.options ?? ytdlpOptionsFromEnv();
  const maxBytes = options.maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
  const id = downloadId(track);
  await mkdir(destDir, { recursive: true });

  const args = buildDownloadArgs(track, destDir, ytdlpOptions, maxBytes);
  const spawnFn = options.spawn ?? spawn;

  return new Promise<string>((resolve, reject) => {
    const child = spawnFn(ytdlpOptions.path, args, {
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
    });
    const stderrLines: string[] = [];
    let stderrRemainder = "";
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (path: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(path);
    };

    const fail = (error: MediaError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = (): void => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      fail(new MediaError("DOWNLOAD_ABORTED", "The download was cancelled."));
    };

    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      fail(new MediaError("DOWNLOAD_FAILED", "The download timed out."));
    }, DOWNLOAD_TIMEOUT_MS);
    timer.unref?.();

    signal?.addEventListener("abort", onAbort, { once: true });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const parts = `${stderrRemainder}${chunk}`.split(/\r?\n/);
      stderrRemainder = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.trim()) continue;
        stderrLines.push(part);
        if (stderrLines.length > 20) stderrLines.shift();
      }
    });

    child.on("error", (error) => {
      fail(
        new MediaError(
          "SPAWN_FAILED",
          `Could not start yt-dlp at "${ytdlpOptions.path}": ${error.message}`,
        ),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      if (stderrRemainder.trim()) stderrLines.push(stderrRemainder);
      const stderr = stderrLines.join("\n");

      if (code !== 0) {
        if (/max-filesize|larger than/i.test(stderr)) {
          fail(new MediaError("DOWNLOAD_TOO_LARGE", "The track is larger than the cache limit."));
          return;
        }
        const reason = lastStderrLine(stderr);
        fail(
          new MediaError(
            "DOWNLOAD_FAILED",
            `Could not download the track${reason ? `: ${reason}` : "."}`,
            stderr,
          ),
        );
        return;
      }

      void (async () => {
        let names: string[] = [];
        try {
          names = await readdir(destDir);
        } catch {
          names = [];
        }
        const matches = names
          .filter((name) => name.startsWith(`${id}.`) && !name.endsWith(".part"))
          .sort();
        const produced = matches[0];
        if (!produced) {
          fail(new MediaError("DOWNLOAD_FAILED", "yt-dlp produced no audio file."));
          return;
        }

        const path = join(destDir, produced);
        let size = 0;
        try {
          size = (await stat(path)).size;
        } catch {
          size = 0;
        }
        if (size > maxBytes) {
          await removeLeftovers(destDir, id);
          fail(new MediaError("DOWNLOAD_TOO_LARGE", "The track is larger than the cache limit."));
          return;
        }

        await removeLeftovers(destDir, id, path);
        finish(path);
      })();
    });
  });
}
