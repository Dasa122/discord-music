import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export type LoudnessMode = "loudnorm" | "dynaudnorm" | "off";

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

/** Mirrors the config defaults so a caller that omits settings still normalises. */
export const DEFAULT_LOUDNESS_SETTINGS: LoudnessSettings = {
  mode: "loudnorm",
  targetLufs: -16,
  truePeakDb: -1.5,
  lra: 11,
  dynFrameMs: 150,
};

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

export interface FfmpegOptions {
  ffmpegPath?: string;
  /** Defaults to loudnorm so every decoded track is normalised. */
  normalization?: LoudnessSettings;
}

export interface FfmpegFileStream {
  stream: Readable;
  /** Kill the decoder; destroying the stream is enough for the pipe. */
  kill(): void;
}

function appendOutputTail(args: string[], options: FfmpegOptions): void {
  const filter = buildAudioFilter(options.normalization ?? DEFAULT_LOUDNESS_SETTINGS);
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
