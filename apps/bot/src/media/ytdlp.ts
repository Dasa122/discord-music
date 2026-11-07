import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { MediaError } from "../errors.js";
import { logger } from "../logger.js";
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
  /** Persists the extractor's challenge/player work across invocations. */
  cacheDir?: string;
}

export interface ResolvedTrack {
  videoId: string | null;
  title: string;
  webpageUrl: string;
  durationSec: number | null;
  thumbnailUrl: string | null;
  isPlaylist: boolean;
  entries?: ResolvedTrack[];
  /**
   * Direct media URL for the play that follows this resolve. Signed and bound
   * to the requesting IP/User-Agent, so it is never cached: the resolve cache
   * drops it and the player keeps it only until the next open.
   */
  streamUrl?: string;
  /** HTTP headers `streamUrl` must be fetched with. */
  headers?: Record<string, string>;
}

/** Authoritative metadata printed by a download (`--print-json`). */
export interface TrackInfo {
  videoId: string | null;
  title: string | null;
  durationSec: number | null;
  thumbnailUrl: string | null;
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
    cacheDir: env.YTDLP_CACHE_DIR?.trim() || undefined,
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

  if (options.cacheDir) {
    // The cache lives for the container's lifetime, so the player/JS challenge
    // work is solved once instead of on every extraction.
    args.push("--cache-dir", options.cacheDir);
  }
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

export function isPlaylistUrl(value: string): boolean {
  return isHttpUrl(value) && /(?:[?&]list=|\/playlist\/|\/sets\/)/i.test(value);
}

/** Extract the video id from the YouTube URL shapes users paste. */
export function youtubeVideoIdFromUrl(value: string): string | null {
  const trimmed = value.trim();
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{6,32})/,
    /youtu\.be\/([A-Za-z0-9_-]{6,32})/,
    /\/shorts\/([A-Za-z0-9_-]{6,32})/,
    /\/embed\/([A-Za-z0-9_-]{6,32})/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    if (match?.[1]) return match[1];
  }
  return null;
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

/**
 * A flat search result has no thumbnails list; YouTube's static id URL is the
 * same image, so it can be derived without visiting the video page.
 */
export function thumbnailFromVideoId(videoId: string | null): string | null {
  if (!videoId || !/^[A-Za-z0-9_-]{6,32}$/.test(videoId)) return null;
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function isYoutubeUrl(value: string): boolean {
  return /youtube\.com|youtu\.be/i.test(value);
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
    thumbnailUrl:
      thumbnailFrom(record) ?? (isYoutubeUrl(webpageUrl) ? thumbnailFromVideoId(videoId) : null),
    isPlaylist: false,
  };
}

function trackInfoFrom(raw: Record<string, unknown>): TrackInfo | null {
  const videoId = stringValue(raw.id);
  const title = stringValue(raw.title) ?? stringValue(raw.fulltitle);
  const durationSec = numberValue(raw.duration);
  const webpageUrl = normalizeWebpageUrl(raw, videoId);
  const thumbnailUrl =
    thumbnailFrom(raw) ??
    (webpageUrl && isYoutubeUrl(webpageUrl) ? thumbnailFromVideoId(videoId) : null);

  if (title === null && durationSec === null && thumbnailUrl === null) return null;
  return { videoId, title, durationSec, thumbnailUrl };
}

/**
 * Parse the JSON a download prints (`--print-json`). Best effort by design:
 * a truncated or non-JSON line only costs the metadata, never the playback.
 */
export function parseTrackInfo(stdout: string): TrackInfo | null {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line?.startsWith("{")) continue;
    try {
      const raw = asRecord(JSON.parse(line));
      if (!raw) continue;
      const info = trackInfoFrom(raw);
      if (info) return info;
    } catch {
      // Ignore garbage: the caller falls back to the queued metadata.
    }
  }
  return null;
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
  const searchRequest = /^ytsearch\d*:/i.test(target);
  return [
    ...buildCommonArgs(options),
    "--dump-single-json",
    ...(playlistRequest
      ? ["--yes-playlist", "--flat-playlist", "--playlist-end", String(MAX_PLAYLIST_ENTRIES)]
      : searchRequest
        ? // Search results already carry title/duration, so a flat listing avoids
          // visiting (and extracting) each video page.
          ["--flat-playlist"]
        : []),
    "--",
    target,
  ];
}

/** Args for a bounded flat search; exported so the argv contract stays testable. */
export function buildSearchArgs(query: string, limit: number, options: YtdlpOptions): string[] {
  const bounded = Math.max(1, Math.min(10, Math.trunc(limit)));
  return [
    ...buildCommonArgs(options),
    "--dump-single-json",
    "--flat-playlist",
    "--",
    `ytsearch${bounded}:${query}`,
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

  const startedAt = Date.now();
  const stdout = await withExtractionSlot(() => runYtdlp(args, options));
  logger.debug("resolve_ms", {
    ms: Date.now() - startedAt,
    kind: playlistRequest ? "playlist" : /^ytsearch\d*:/i.test(ytdlpTarget) ? "search" : "single",
  });
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
  const args = buildSearchArgs(trimmed, bounded, options);

  const startedAt = Date.now();
  const stdout = await withExtractionSlot(() => runYtdlp(args, options));
  logger.debug("resolve_ms", { ms: Date.now() - startedAt, kind: "search" });
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
  /** Streamed download progress; malformed lines are ignored. */
  onProgress?: (progress: DownloadProgressEvent) => void;
  /** Injection point for tests; production always uses the real spawn. */
  spawn?: typeof spawn;
}

export interface DownloadProgressEvent {
  downloadedBytes: number;
  totalBytes: number | null;
}

/** Progress lines are prefixed so they never collide with the info JSON. */
export const PROGRESS_PREFIX = "dl:";

/**
 * Parse one `--progress-template` line (`dl:123/456`, `dl:123/NA`) into
 * numbers. Anything malformed is ignored rather than failing the download.
 */
export function parseProgressLine(line: string): DownloadProgressEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(PROGRESS_PREFIX)) return null;

  const body = trimmed.slice(PROGRESS_PREFIX.length);
  const slash = body.indexOf("/");
  if (slash < 0) return null;

  const downloaded = Number(body.slice(0, slash));
  const totalRaw = body.slice(slash + 1).trim();
  const total =
    totalRaw === "" || totalRaw === "NA" || totalRaw === "None" ? null : Number(totalRaw);

  if (!Number.isFinite(downloaded) || downloaded < 0) return null;
  if (total !== null && (!Number.isFinite(total) || total < 0)) return null;

  return { downloadedBytes: downloaded, totalBytes: total };
}

/** The produced file plus the authoritative metadata the download printed. */
export interface DownloadResult {
  path: string;
  info: TrackInfo | null;
}

export const DEFAULT_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 300_000;
/** `--print-json` output for one video is small; anything past this is ignored. */
export const MAX_DOWNLOAD_INFO_BYTES = 1024 * 1024;

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
    // `--progress` re-enables the output that common args disable; the prefix
    // keeps progress lines distinguishable from the info JSON on stdout.
    "--newline",
    "--progress",
    "--progress-template",
    "dl:%(progress.downloaded_bytes)s/%(progress.total_bytes)s",
    // One extraction for both the file and its metadata. `--print-json` maps to
    // the dump-json switch, which would simulate by default; `--no-simulate`
    // keeps the download and still prints the info JSON.
    "--print-json",
    "--no-simulate",
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
 * Download one track's audio into `destDir` and return the produced file plus
 * the metadata yt-dlp printed during the same extraction.
 * The caller owns the file from that point (the cache atomically renames it).
 */
export async function downloadAudio(
  track: DownloadTrack,
  destDir: string,
  options: DownloadAudioOptions = {},
): Promise<DownloadResult> {
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

  return new Promise<DownloadResult>((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawnFn(ytdlpOptions.path, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stderrLines: string[] = [];
    let stderrRemainder = "";
    let stdout = "";
    let stdoutRemainder = "";
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (path: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      logger.debug("download_ms", { ms: Date.now() - startedAt, trackId: id });
      resolve({ path, info: parseTrackInfo(stdout) });
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

    const handleStdoutLine = (line: string): void => {
      const progress = parseProgressLine(line);
      if (progress) {
        options.onProgress?.(progress);
        return;
      }
      if (stdout.length >= MAX_DOWNLOAD_INFO_BYTES) return;
      stdout += `${line}\n`;
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const parts = `${stdoutRemainder}${chunk}`.split(/\r?\n/);
      stdoutRemainder = parts.pop() ?? "";
      for (const part of parts) handleStdoutLine(part);
    });
    // A destroyed pipe must not surface as an unhandled stream error.
    child.stdout?.on("error", () => {});

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
      if (stdoutRemainder) {
        handleStdoutLine(stdoutRemainder);
        stdoutRemainder = "";
      }
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
