import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { Readable } from "node:stream";
import { logger } from "../logger.js";

export type LoudnessMode = "loudnorm" | "dynaudnorm" | "off";

/**
 * How the streamed first play of a track is filtered. A stream cannot be
 * measured before it starts, so a one-pass `loudnorm` there dynamically cuts a
 * hot master (a −8 LUFS / +2.6 dBTP track needed ~8 dB of ducking to hit −16,
 * audible as "it goes quiet after ~10 s"). `limiter` only catches peaks: no
 * gain change, no pumping, at the cost of track 1 possibly being louder than
 * the rest until its measured gain is available on a later play.
 */
export type StreamFilterMode = "limiter" | "loudnorm" | "dynaudnorm" | "off";

export interface LoudnessSettings {
  mode: LoudnessMode;
  /** Integrated loudness target in LUFS (`loudnorm` only). */
  targetLufs: number;
  /** True-peak ceiling in dBTP (`loudnorm` only). */
  truePeakDb: number;
  /** Loudness range target (`loudnorm` only). */
  lra: number;
  /** Analysis window in milliseconds (`dynaudnorm` only). */
  dynFrameMs: number;
}

/** Loudness settings plus the separate stream-path mode. */
export interface PlaybackAudioConfig extends LoudnessSettings {
  /** `AUDIO_STREAM_FILTER`: filter applied to the streamed first play. */
  streamFilter: StreamFilterMode;
}

/** Mirrors the config defaults so a caller that omits settings still normalises. */
export const DEFAULT_LOUDNESS_SETTINGS: LoudnessSettings = {
  mode: "loudnorm",
  targetLufs: -14,
  truePeakDb: -1,
  lra: 11,
  dynFrameMs: 150,
};

/** Default streamed-play filter: peak limiting only, never a gain change. */
export const DEFAULT_STREAM_FILTER: StreamFilterMode = "limiter";

/** Brick-wall peak limiter at 0.891 (~−1 dBFS), with no makeup gain. */
export const LIMITER_FILTER = "alimiter=limit=0.891:level=false";

/** Upper bound on a measured gain boost (dB); attenuation uses the same limit. */
export const DEFAULT_MAX_GAIN_DB = 12;

/**
 * The single source of truth for the loudness filter. Returns `null` for
 * `off`, which means the caller must not emit an `-af` argument at all.
 */
export function buildAudioFilter(settings: LoudnessSettings): string | null {
  switch (settings.mode) {
    case "loudnorm":
      return `loudnorm=I=${settings.targetLufs}:TP=${settings.truePeakDb}:LRA=${settings.lra}`;
    case "dynaudnorm":
      return `dynaudnorm=f=${settings.dynFrameMs}:g=15:p=0.7`;
    case "off":
      return null;
  }
}

/** Round to 2 decimals so a measured gain stays readable in logs and argv. */
function roundGain(gainDb: number): number {
  return Math.round(gainDb * 100) / 100;
}

/**
 * Gain that brings `inputLufs` to `targetLufs`, kept within `±maxGainDb` and
 * then reduced so the true peak does not exceed `truePeakLimitDb`.
 */
export function computeGainDb(
  inputLufs: number,
  truePeakDb: number,
  targetLufs: number,
  truePeakLimitDb: number,
  maxGainDb: number,
): number {
  const clamped = Math.min(maxGainDb, Math.max(-maxGainDb, targetLufs - inputLufs));
  return Math.min(clamped, truePeakLimitDb - truePeakDb);
}

/** A fixed gain plus a brick-wall limiter at 0.891 (~-1 dBFS). */
export function buildMeasuredFilter(gainDb: number): string {
  return `volume=${roundGain(gainDb)}dB,${LIMITER_FILTER}`;
}

/** The streamed-path filter, or `null` when it must not emit `-af` at all. */
export function buildStreamFilter(config: PlaybackAudioConfig): string | null {
  switch (config.streamFilter) {
    case "limiter":
      return LIMITER_FILTER;
    case "loudnorm":
      return buildAudioFilter({ ...config, mode: "loudnorm" });
    case "dynaudnorm":
      return buildAudioFilter({ ...config, mode: "dynaudnorm" });
    case "off":
      return null;
  }
}

export type PlayFilterKind = "measured" | "stream" | "configured" | "off";

export interface PlayFilterSelection {
  /** The `-af` value, or `null` when no filter must be emitted at all. */
  filter: string | null;
  kind: PlayFilterKind;
  gainDb?: number;
}

/**
 * Pick the playback filter — the whole source/measurement matrix lives here.
 *
 * - `AUDIO_NORMALIZE=off` wins everywhere and emits no `-af` at all.
 * - A cached track with a measurement always replays its exact gain plus the
 *   limiter, regardless of `AUDIO_STREAM_FILTER`.
 * - A cached track without one falls back to `AUDIO_NORMALIZE`.
 * - The streamed first play uses `AUDIO_STREAM_FILTER`, which defaults to a
 *   limiter so a hot master is not dynamically ducked.
 */
export function selectPlaybackFilter(input: {
  source: "cache" | "stream";
  /** A finite measured gain exists for this cached track. */
  hasMeasurement: boolean;
  gainDb?: number | null;
  config: PlaybackAudioConfig;
}): PlayFilterSelection {
  if (input.config.mode === "off") return { filter: null, kind: "off" };

  if (input.source === "stream") {
    const streamFilter = buildStreamFilter(input.config);
    return streamFilter ? { filter: streamFilter, kind: "stream" } : { filter: null, kind: "off" };
  }

  if (input.hasMeasurement && typeof input.gainDb === "number" && Number.isFinite(input.gainDb)) {
    return {
      filter: buildMeasuredFilter(input.gainDb),
      kind: "measured",
      gainDb: input.gainDb,
    };
  }

  const configured = buildAudioFilter(input.config);
  return configured ? { filter: configured, kind: "configured" } : { filter: null, kind: "off" };
}

/** The loudnorm figures the analysis pass prints as its trailing JSON block. */
export interface LoudnessMeasurement {
  inputLufs: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Extract the last loudnorm JSON object from ffmpeg stderr. Returns `null` for
 * a silent input (`-inf`), missing/invalid keys, or no JSON at all.
 */
export function parseLoudnormJson(stderr: string): LoudnessMeasurement | null {
  const blocks = [...stderr.matchAll(/\{[^{}]*\}/g)];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!block) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(block[0]);
    } catch {
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const inputLufs = finiteNumber(record.input_i);
    const inputTp = finiteNumber(record.input_tp);
    const inputLra = finiteNumber(record.input_lra);
    const inputThresh = finiteNumber(record.input_thresh);
    if (inputLufs === null || inputTp === null || inputLra === null || inputThresh === null) {
      continue;
    }
    return { inputLufs, inputTp, inputLra, inputThresh };
  }
  return null;
}

export interface AnalyzeLoudnessOptions {
  ffmpegPath?: string;
}

function logAnalysisFailure(filePath: string, reason: string): void {
  logger.debug("loudness_analysis_failed", { file: basename(filePath), reason });
}

/**
 * Measure a local file with a loudnorm analysis pass. Best-effort by contract:
 * every failure resolves to `null` so playback is never blocked by analysis.
 */
export async function analyzeLoudness(
  filePath: string,
  settings: LoudnessSettings = DEFAULT_LOUDNESS_SETTINGS,
  options: AnalyzeLoudnessOptions = {},
): Promise<LoudnessMeasurement | null> {
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH?.trim() ?? "ffmpeg";
  const args = [
    "-hide_banner",
    "-nostats",
    "-i",
    filePath,
    "-af",
    `loudnorm=I=${settings.targetLufs}:TP=${settings.truePeakDb}:LRA=${settings.lra}:print_format=json`,
    "-f",
    "null",
    "-",
  ];

  return new Promise<LoudnessMeasurement | null>((resolvePromise) => {
    let settled = false;
    let stderr = "";

    const finish = (value: LoudnessMeasurement | null): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };

    try {
      const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-16_000);
      });

      child.on("error", (error) => {
        logAnalysisFailure(filePath, `could not start ffmpeg: ${error.message}`);
        finish(null);
      });

      child.on("close", (code) => {
        const measurement = parseLoudnormJson(stderr);
        if (measurement) {
          finish(measurement);
          return;
        }
        const silent = /"input_i"\s*:\s*"-?inf"/i.test(stderr);
        logAnalysisFailure(
          filePath,
          silent
            ? "the input is silent"
            : code === 0
              ? "no readable loudnorm JSON in the output"
              : `ffmpeg exited with code ${code}`,
        );
        finish(null);
      });
    } catch (error) {
      logAnalysisFailure(
        filePath,
        error instanceof Error ? error.message : "the analysis pass could not start",
      );
      finish(null);
    }
  });
}

export interface FfmpegOptions {
  ffmpegPath?: string;
  /** Defaults to loudnorm so every decoded track is normalised. */
  normalization?: LoudnessSettings;
  /** Per-call filter override; `null` means no `-af` at all. */
  filter?: string | null;
}

export interface FfmpegFileStream {
  stream: Readable;
  /** Kill the decoder; destroying the stream is enough for the pipe. */
  kill(): void;
}

export interface FfmpegUrlStream extends FfmpegFileStream {
  /**
   * Settles when ffmpeg exits, carrying its stderr tail. A failed HTTP open
   * closes stdout first, so the stderr reason arrives after the stream error —
   * this is what lets the caller tell a stale 403 from a genuine empty file.
   */
  exit?: Promise<{ code: number | null; stderr: string }>;
}

function appendOutputTail(args: string[], options: FfmpegOptions): void {
  const filter =
    options.filter !== undefined
      ? options.filter
      : buildAudioFilter(options.normalization ?? DEFAULT_LOUDNESS_SETTINGS);
  if (filter) args.push("-af", filter);
  args.push("-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1");
}

/** Args for decoding a file: `-ss` stays before `-i` for a fast input seek. */
export function toPcmFromFileArgs(
  filePath: string,
  options: FfmpegOptions & { startSec?: number } = {},
): string[] {
  const startSec = Math.max(0, Math.floor(options.startSec ?? 0));
  const args = ["-hide_banner", "-loglevel", "error"];
  if (startSec > 0) args.push("-ss", String(startSec));
  args.push("-i", filePath);
  appendOutputTail(args, options);
  return args;
}

/** Args for decoding a stdin pipe (`pipe:0`). */
export function toPcmArgs(options: FfmpegOptions = {}): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0"];
  appendOutputTail(args, options);
  return args;
}

/**
 * One `-headers` value for ffmpeg. A header value is attacker-adjacent input
 * (it comes from the extractor), so CR/LF are stripped: a newline in a value
 * would let it inject a second header or a whole extra request.
 */
export function sanitizeStreamHeaders(headers?: Record<string, string>): string | null {
  if (!headers) return null;
  const lines: string[] = [];
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName)
      .replace(/[\r\n]/g, "")
      .trim();
    if (!name) continue;
    const value = String(rawValue).replace(/[\r\n]/g, "");
    lines.push(`${name}: ${value}`);
  }
  return lines.length > 0 ? lines.join("\r\n") : null;
}

/**
 * Args for decoding a remote URL. `-headers` and `-ss` are input options, so
 * both must precede `-i`; the output tail always comes last.
 */
export function toPcmFromUrlArgs(
  url: string,
  headers?: Record<string, string>,
  options: FfmpegOptions & { startSec?: number } = {},
): string[] {
  const startSec = Math.max(0, Math.floor(options.startSec ?? 0));
  const args = ["-hide_banner", "-loglevel", "error"];
  const headerBlock = sanitizeStreamHeaders(headers);
  if (headerBlock) args.push("-headers", headerBlock);
  args.push("-ss", String(startSec), "-i", url);
  appendOutputTail(args, options);
  return args;
}

/**
 * Decode a remote media URL to 48 kHz stereo s16le PCM on stdout. Used for a
 * resolver-provided stream URL, which skips yt-dlp at playback time.
 */
export function toPcmFromUrl(
  url: string,
  headers?: Record<string, string>,
  options: FfmpegOptions & { startSec?: number } = {},
): FfmpegUrlStream {
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH?.trim() ?? "ffmpeg";

  const child = spawn(ffmpegPath, toPcmFromUrlArgs(url, headers, options), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = child.stdout;
  let stderr = "";
  let settleExit!: (value: { code: number | null; stderr: string }) => void;
  const exit = new Promise<{ code: number | null; stderr: string }>((resolvePromise) => {
    settleExit = resolvePromise;
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });

  child.on("error", (error) => {
    output.destroy(new Error(`Could not start ffmpeg at "${ffmpegPath}": ${error.message}`));
  });

  child.on("close", (code) => {
    settleExit({ code, stderr });
    if (code !== 0 && code !== null && !output.destroyed) {
      const reason = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .pop();
      output.destroy(new Error(`ffmpeg exited with code ${code}${reason ? `: ${reason}` : ""}`));
    }
  });

  output.on("error", () => {});

  return {
    stream: output,
    exit,
    kill: () => {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
      output.destroy();
    },
  };
}

/**
 * Decode a local audio file to 48 kHz stereo s16le PCM on stdout.
 * `-ss` sits before `-i` so the seek is a fast input seek.
 */
export function toPcmFromFile(
  filePath: string,
  options: FfmpegOptions & { startSec?: number } = {},
): FfmpegFileStream {
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH?.trim() ?? "ffmpeg";

  const child = spawn(ffmpegPath, toPcmFromFileArgs(filePath, options), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = child.stdout;
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });

  child.on("error", (error) => {
    output.destroy(new Error(`Could not start ffmpeg at "${ffmpegPath}": ${error.message}`));
  });

  child.on("close", (code) => {
    if (code !== 0 && code !== null && !output.destroyed) {
      const reason = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .pop();
      output.destroy(new Error(`ffmpeg exited with code ${code}${reason ? `: ${reason}` : ""}`));
    }
  });

  output.on("error", () => {});

  return {
    stream: output,
    kill: () => {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
      output.destroy();
    },
  };
}

/**
 * Decode any input stream to 48 kHz stereo s16le PCM on stdout.
 * Destroying the returned stream kills both the ffmpeg process and, via the
 * input error handler, the upstream producer.
 */
export function toPcm(input: Readable, options: FfmpegOptions = {}): Readable {
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH?.trim() ?? "ffmpeg";

  const child = spawn(ffmpegPath, toPcmArgs(options), { stdio: ["pipe", "pipe", "pipe"] });

  const output = child.stdout;
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });

  input.on("error", (error) => {
    if (child.exitCode === null) child.kill("SIGKILL");
    output.destroy(error);
  });
  input.pipe(child.stdin);
  child.stdin.on("error", () => {});

  child.on("error", (error) => {
    output.destroy(new Error(`Could not start ffmpeg at "${ffmpegPath}": ${error.message}`));
  });

  child.on("close", (code) => {
    if (code !== 0 && code !== null && !output.destroyed) {
      const reason = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .pop();
      output.destroy(new Error(`ffmpeg exited with code ${code}${reason ? `: ${reason}` : ""}`));
    }
  });

  output.on("error", () => {});
  output.on("close", () => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  return output;
}
