import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export interface FfmpegOptions {
  ffmpegPath?: string;
}

export interface FfmpegFileStream {
  stream: Readable;
  /** Kill the decoder; destroying the stream is enough for the pipe. */
  kill(): void;
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
  const startSec = Math.max(0, Math.floor(options.startSec ?? 0));
  const args = ["-hide_banner", "-loglevel", "error"];
  if (startSec > 0) args.push("-ss", String(startSec));
  args.push("-i", filePath, "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1");

  const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
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

  const child = spawn(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

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
