import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";
import { MediaError } from "../errors.js";

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
      stdout += chunk;
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

export async function resolve(
  query: string,
  options: YtdlpOptions = ytdlpOptionsFromEnv(),
): Promise<ResolvedTrack> {
  const trimmed = query.trim();
  if (!trimmed) throw new MediaError("NOT_FOUND", "The search query is empty.");

  const playlistRequest = isPlaylistUrl(trimmed);
  const target = isHttpUrl(trimmed) ? trimmed : `ytsearch1:${trimmed}`;
  const args = [
    ...buildCommonArgs(options),
    "--dump-single-json",
    ...(playlistRequest ? ["--yes-playlist", "--flat-playlist"] : []),
    "--",
    target,
  ];

  const stdout = await runYtdlp(args, options);
  const raw = parseJsonOutput(stdout);
  const type = stringValue(raw._type);

  if (type === "playlist") {
    const entriesRaw = Array.isArray(raw.entries) ? raw.entries : [];
    const entries = entriesRaw
      .map(mapEntry)
      .filter((entry): entry is ResolvedTrack => entry !== null);

    if (!playlistRequest) {
      const first = entries[0];
      if (!first) throw new MediaError("NOT_FOUND", "No playable result was found.");
      return first;
    }

    const title = stringValue(raw.title) ?? "Playlist";
    const webpageUrl = stringValue(raw.webpage_url) ?? trimmed;
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

  const bounded = Math.max(1, Math.min(10, Math.trunc(limit)));
  const args = [
    ...buildCommonArgs(options),
    "--dump-single-json",
    "--flat-playlist",
    "--",
    `ytsearch${bounded}:${trimmed}`,
  ];

  const stdout = await runYtdlp(args, options);
  const raw = parseJsonOutput(stdout);
  const type = stringValue(raw._type);

  if (type === "playlist") {
    const entriesRaw = Array.isArray(raw.entries) ? raw.entries : [];
    return entriesRaw
      .map(mapEntry)
      .filter((entry): entry is ResolvedTrack => entry !== null)
      .slice(0, bounded);
  }

  const single = mapEntry(raw);
  return single ? [single] : [];
}

export function openAudioStream(
  track: { url: string; title?: string },
  options: OpenAudioStreamOptions = {},
): OpenAudioStreamResult {
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
