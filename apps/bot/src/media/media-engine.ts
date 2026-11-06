import { PassThrough, type Readable } from "node:stream";
import { MediaError } from "../errors.js";
import { toPcm } from "./ffmpeg.js";
import {
  openAudioStream,
  type ResolvedTrack,
  resolve,
  resolveSearch,
  type YtdlpOptions,
} from "./ytdlp.js";

export type { ResolvedTrack } from "./ytdlp.js";

export interface OpenedStream {
  stream: Readable;
  stop(): void;
}

export interface MediaEngine {
  resolve(query: string): Promise<ResolvedTrack>;
  resolveSearch(query: string, limit: number): Promise<ResolvedTrack[]>;
  open(
    track: { url: string; title?: string },
    options?: { startSec?: number },
  ): Promise<OpenedStream>;
}

const DEFAULT_PREBUFFER_BYTES = 192_000; // ~1 s of 48 kHz stereo s16le
const DEFAULT_PREBUFFER_TIMEOUT_MS = 15_000;

function readFirstChunks(stream: Readable, minBytes: number, timeoutMs: number): Promise<Buffer[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.pause();
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(chunks);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };

    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      bytes += buffer.length;
      if (bytes >= minBytes) finish();
    };

    const onEnd = (): void => {
      if (bytes > 0) finish();
      else fail(new MediaError("NOT_FOUND", "The track produced no audio."));
    };

    const onError = (error: Error): void => {
      fail(error);
    };

    const timer = setTimeout(() => {
      if (bytes > 0) finish();
      else fail(new MediaError("EXTRACTOR_FAILED", "Timed out waiting for audio from yt-dlp."));
    }, timeoutMs);
    timer.unref?.();

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

export class YtdlpMediaEngine implements MediaEngine {
  private readonly ytdlpOptions: YtdlpOptions;
  private readonly ffmpegPath: string;
  private readonly prebufferBytes: number;
  private readonly prebufferTimeoutMs: number;

  constructor(
    ytdlpOptions: YtdlpOptions,
    ffmpegPath: string,
    prebufferBytes = DEFAULT_PREBUFFER_BYTES,
    prebufferTimeoutMs = DEFAULT_PREBUFFER_TIMEOUT_MS,
  ) {
    this.ytdlpOptions = ytdlpOptions;
    this.ffmpegPath = ffmpegPath;
    this.prebufferBytes = prebufferBytes;
    this.prebufferTimeoutMs = prebufferTimeoutMs;
  }

  resolve(query: string): Promise<ResolvedTrack> {
    return resolve(query, this.ytdlpOptions);
  }

  resolveSearch(query: string, limit: number): Promise<ResolvedTrack[]> {
    return resolveSearch(query, limit, this.ytdlpOptions);
  }

  async open(
    track: { url: string; title?: string },
    options: { startSec?: number } = {},
  ): Promise<OpenedStream> {
    const ytdlp = await openAudioStream(track, {
      startSec: options.startSec ?? 0,
      options: this.ytdlpOptions,
    });
    const pcm = toPcm(ytdlp.stream, { ffmpegPath: this.ffmpegPath });
    const output = new PassThrough();
    let stopped = false;

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (ytdlp.process.exitCode === null) {
        try {
          ytdlp.process.kill("SIGKILL");
        } catch {
          // Process already gone.
        }
      }
      pcm.destroy();
      output.destroy();
    };

    pcm.on("error", (error) => {
      if (!output.destroyed) output.destroy(error);
    });
    output.on("close", () => {
      if (!stopped) stop();
    });

    try {
      const chunks = await readFirstChunks(pcm, this.prebufferBytes, this.prebufferTimeoutMs);
      for (const chunk of chunks) output.write(chunk);
      pcm.pipe(output);
    } catch (error) {
      stop();
      if (error instanceof MediaError) throw error;
      throw new MediaError(
        "EXTRACTOR_FAILED",
        error instanceof Error
          ? `Could not start the audio pipeline: ${error.message}`
          : "Could not start the audio pipeline.",
      );
    }

    return { stream: output, stop };
  }
}
