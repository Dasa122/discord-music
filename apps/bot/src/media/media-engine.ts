import { PassThrough, type Readable } from "node:stream";
import { MediaError } from "../errors.js";
import { logger } from "../logger.js";
import type { AudioCache } from "./audio-cache.js";
import { type LoudnessSettings, toPcm, toPcmFromFile } from "./ffmpeg.js";
import { QueuedSemaphore } from "./limits.js";
import {
  downloadAudio,
  openAudioStream,
  type ResolvedTrack,
  resolve,
  resolveSearch,
  type TrackInfo,
  type YtdlpOptions,
  youtubeVideoIdFromUrl,
} from "./ytdlp.js";

export type { ResolvedTrack, TrackInfo } from "./ytdlp.js";

/** 250 ms of 48 kHz stereo s16le; a local file needs almost no head start. */
export const CACHE_PREBUFFER_BYTES = 48_000;
/** ~1 s; yt-dlp has to reach the network before it can play. */
export const STREAM_PREBUFFER_BYTES = 192_000;
export const DEFAULT_PREBUFFER_TIMEOUT_MS = 15_000;

export interface MediaTrack {
  id?: string;
  videoId?: string | null;
  url: string;
  title?: string;
  durationSec?: number | null;
  isLive?: boolean;
}

export interface OpenedStream {
  stream: Readable;
  stop(): void;
  source: "cache" | "stream";
}

export interface OpenTrackOptions {
  startSec?: number;
  sessionId?: string;
}

export interface MediaEngine {
  /** `sessionId` enables the cache-first path for a YouTube URL. */
  resolve(query: string, sessionId?: string): Promise<ResolvedTrack>;
  resolveSearch(query: string, limit: number): Promise<ResolvedTrack[]>;
  open(track: MediaTrack, options?: OpenTrackOptions): Promise<OpenedStream>;
  prepare?(track: MediaTrack, sessionId?: string): Promise<void>;
  /** Metadata captured by the download that populated the cache. */
  preparedInfo?(track: MediaTrack, sessionId?: string): TrackInfo | null;
  /** Fire-and-forget cache fill for a track that is currently streaming. */
  ensureCached?(track: MediaTrack, sessionId?: string): Promise<void>;
  prefetch?(track: MediaTrack, sessionId?: string): Promise<void>;
  cancelPrefetch?(sessionId?: string): void;
  pin?(sessionId: string, trackId: string): Promise<void>;
  unpin?(sessionId: string, trackId: string): Promise<void>;
  releaseSession?(sessionId: string): Promise<void>;
}

export interface MediaEngineDeps {
  downloadAudio: typeof downloadAudio;
  openAudioStream: typeof openAudioStream;
  resolve: typeof resolve;
  resolveSearch: typeof resolveSearch;
  toPcm: typeof toPcm;
  toPcmFromFile: typeof toPcmFromFile;
}

export interface YtdlpMediaEngineOptions {
  ytdlp: YtdlpOptions;
  ffmpegPath: string;
  /** Applied to every decoded track on both the stream and cached-file paths. */
  normalization?: LoudnessSettings;
  cache?: AudioCache | null;
  prefetchEnabled?: boolean;
  prefetchMaxConcurrent?: number;
  maxCacheFileBytes?: number;
  cachePrebufferBytes?: number;
  streamPrebufferBytes?: number;
  prebufferTimeoutMs?: number;
  deps?: Partial<MediaEngineDeps>;
}

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
      else fail(new MediaError("EXTRACTOR_FAILED", "Timed out waiting for audio."));
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
  private readonly normalization: LoudnessSettings | undefined;
  private readonly cache: AudioCache | null;
  private readonly prefetchEnabled: boolean;
  private readonly prefetchSemaphore: QueuedSemaphore;
  private readonly maxCacheFileBytes: number;
  private readonly cachePrebufferBytes: number;
  private readonly streamPrebufferBytes: number;
  private readonly prebufferTimeoutMs: number;
  private readonly deps: MediaEngineDeps;

  private readonly preparing = new Map<string, Promise<void>>();
  private readonly prepareAborts = new Map<string, AbortController>();
  private readonly preparedInfoByKey = new Map<string, TrackInfo>();
  private readonly prefetching = new Map<string, Promise<void>>();
  private readonly prefetchAborts = new Map<string, AbortController>();

  constructor(options: YtdlpMediaEngineOptions) {
    this.ytdlpOptions = options.ytdlp;
    this.ffmpegPath = options.ffmpegPath;
    this.normalization = options.normalization;
    this.cache = options.cache ?? null;
    this.prefetchEnabled = options.prefetchEnabled ?? true;
    this.prefetchSemaphore = new QueuedSemaphore(
      Math.max(1, Math.min(4, options.prefetchMaxConcurrent ?? 2)),
      60_000,
    );
    this.maxCacheFileBytes = options.maxCacheFileBytes ?? 67_108_864;
    this.cachePrebufferBytes = options.cachePrebufferBytes ?? CACHE_PREBUFFER_BYTES;
    this.streamPrebufferBytes = options.streamPrebufferBytes ?? STREAM_PREBUFFER_BYTES;
    this.prebufferTimeoutMs = options.prebufferTimeoutMs ?? DEFAULT_PREBUFFER_TIMEOUT_MS;
    this.deps = {
      downloadAudio,
      openAudioStream,
      resolve,
      resolveSearch,
      toPcm,
      toPcmFromFile,
      ...options.deps,
    };
  }

  async resolve(query: string, sessionId?: string): Promise<ResolvedTrack> {
    const cached = sessionId ? this.cachedResolution(query, sessionId) : null;
    if (cached) return cached;
    return this.deps.resolve(query, this.ytdlpOptions);
  }

  resolveSearch(query: string, limit: number): Promise<ResolvedTrack[]> {
    return this.deps.resolveSearch(query, limit, this.ytdlpOptions);
  }

  /**
   * A YouTube URL whose audio is already in this session's cache needs no
   * extractor run: the download that stored it printed authoritative metadata.
   */
  private cachedResolution(query: string, sessionId: string): ResolvedTrack | null {
    if (!this.cache) return null;
    const videoId = youtubeVideoIdFromUrl(query);
    if (!videoId) return null;
    if (!this.cache.has(sessionId, videoId)) return null;

    const info = this.preparedInfoByKey.get(`${sessionId}:${videoId}`);
    if (!info?.title) return null;

    return {
      videoId,
      title: info.title,
      webpageUrl: query.trim(),
      durationSec: info.durationSec,
      thumbnailUrl: info.thumbnailUrl,
      isPlaylist: false,
    };
  }

  /** Metadata captured by the download that populated the cache. */
  preparedInfo(track: MediaTrack, sessionId?: string): TrackInfo | null {
    if (!sessionId) return null;
    return this.preparedInfoByKey.get(this.cacheKey(sessionId, track)) ?? null;
  }

  /** Download the track into the session cache before playback starts. */
  async prepare(track: MediaTrack, sessionId?: string): Promise<void> {
    const id = this.trackId(track);
    if (!this.cache || !sessionId || !this.cacheable(track)) return;

    const key = this.cacheKey(sessionId, track);
    const existing = this.preparing.get(key);
    if (existing) return existing;

    const controller = new AbortController();
    const startedAt = Date.now();
    const run = (async (): Promise<void> => {
      await this.cache?.claim(sessionId, id);
      if (this.cache?.has(sessionId, id)) return;
      try {
        const dir = this.cache?.tempDirFor(sessionId);
        if (!this.cache || !dir) return;
        const produced = await this.deps.downloadAudio(track, dir, {
          signal: controller.signal,
          maxBytes: this.maxCacheFileBytes,
        });
        // Best-effort: a failed/garbled print only costs the metadata.
        if (produced.info) this.preparedInfoByKey.set(key, produced.info);

        const uploadStartedAt = Date.now();
        await this.cache.storeFile(sessionId, id, produced.path);
        if (this.cache.mode === "s3") {
          logger.debug("s3_put_ms", { ms: Date.now() - uploadStartedAt, trackId: id });
        }
      } catch (error) {
        logger.warn("prepare failed; streaming instead", {
          trackId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        logger.debug("prepare_ms", { ms: Date.now() - startedAt, trackId: id });
      }
    })().finally(() => {
      this.preparing.delete(key);
      this.prepareAborts.delete(key);
    });

    this.preparing.set(key, run);
    this.prepareAborts.set(key, controller);
    return run;
  }

  /** Background-download the next track through its own concurrency budget. */
  async prefetch(track: MediaTrack, sessionId?: string): Promise<void> {
    if (!this.prefetchEnabled || !sessionId) return;
    await this.requestCacheJob(track, sessionId, "prefetch");
  }

  /**
   * Fill the cache for a track that is already streaming. Fire-and-forget by
   * contract: the live stream is never replaced, and a failure is only logged.
   */
  async ensureCached(track: MediaTrack, sessionId?: string): Promise<void> {
    if (!sessionId) return;
    await this.requestCacheJob(track, sessionId, "background");
  }

  private requestCacheJob(
    track: MediaTrack,
    sessionId: string,
    kind: "prefetch" | "background",
  ): Promise<void> {
    const id = this.trackId(track);
    if (!this.cache || !this.cacheable(track)) return Promise.resolve();

    const key = this.cacheKey(sessionId, track);
    const existing = this.prefetching.get(key);
    if (existing) return existing;

    const controller = new AbortController();
    if (kind === "background") {
      logger.debug("background_cache_started", { trackId: id });
    }
    const run = this.runCacheJob(track, id, sessionId, key, controller, kind).finally(() => {
      this.prefetching.delete(key);
      this.prefetchAborts.delete(key);
    });

    this.prefetching.set(key, run);
    this.prefetchAborts.set(key, controller);
    return run;
  }

  private async runCacheJob(
    track: MediaTrack,
    id: string,
    sessionId: string,
    key: string,
    controller: AbortController,
    kind: "prefetch" | "background",
  ): Promise<void> {
    let release: (() => void) | null = null;
    try {
      release = await this.prefetchSemaphore.acquire(
        () => new MediaError("DOWNLOAD_FAILED", "The prefetch queue is full."),
      );
      await this.cache?.claim(sessionId, id);
      if (this.cache?.has(sessionId, id)) return;

      const dir = this.cache?.tempDirFor(sessionId);
      if (!this.cache || !dir) return;
      const produced = await this.deps.downloadAudio(track, dir, {
        signal: controller.signal,
        maxBytes: this.maxCacheFileBytes,
      });
      if (produced.info) this.preparedInfoByKey.set(key, produced.info);
      await this.cache.storeFile(sessionId, id, produced.path);
      if (kind === "background") {
        logger.debug("background_cache_completed", { trackId: id });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (kind === "background") {
        logger.debug("background_cache_failed", { trackId: id, error: message });
      } else {
        logger.debug("prefetch failed; the track can still stream", {
          trackId: id,
          error: message,
        });
      }
    } finally {
      release?.();
    }
  }

  cancelPrefetch(sessionId?: string): void {
    for (const [key, controller] of this.prefetchAborts) {
      if (sessionId && !key.startsWith(`${sessionId}:`)) continue;
      controller.abort();
    }
  }

  async pin(sessionId: string, trackId: string): Promise<void> {
    await this.cache?.pin(sessionId, trackId);
  }

  async unpin(sessionId: string, trackId: string): Promise<void> {
    await this.cache?.unpin(sessionId, trackId);
  }

  async releaseSession(sessionId: string): Promise<void> {
    for (const [key, controller] of this.prepareAborts) {
      if (key.startsWith(`${sessionId}:`)) controller.abort();
    }
    this.cancelPrefetch(sessionId);

    const pending = [
      ...[...this.prefetching.entries()]
        .filter(([key]) => key.startsWith(`${sessionId}:`))
        .map(([, run]) => run),
      ...[...this.preparing.entries()]
        .filter(([key]) => key.startsWith(`${sessionId}:`))
        .map(([, run]) => run),
    ];
    await Promise.allSettled(pending);
    for (const key of [...this.preparedInfoByKey.keys()]) {
      if (key.startsWith(`${sessionId}:`)) this.preparedInfoByKey.delete(key);
    }
    await this.cache?.releaseSession(sessionId);
  }

  async open(track: MediaTrack, options: OpenTrackOptions = {}): Promise<OpenedStream> {
    const startSec = options.startSec ?? 0;
    const id = this.trackId(track);

    if (this.cache && options.sessionId && !track.isLive) {
      if (this.cache.has(options.sessionId, id)) {
        try {
          const target = await this.cache.target(options.sessionId, id);
          if (target) {
            logger.info("play_source", {
              source: "cache",
              trackId: id,
              cachedBytes: this.cache.cachedBytes(options.sessionId, id) ?? undefined,
            });
            return await this.openFile(target, startSec);
          }
        } catch (error) {
          logger.warn("cached audio unavailable; streaming instead", {
            trackId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Stream first, cache in the background: playback never waits for a
    // download and the live resource is never swapped mid-track.
    const opened = await this.openStream(track, startSec);
    logger.info("play_source", { source: "stream", trackId: id });

    if (this.cache && options.sessionId) {
      void this.ensureCached(track, options.sessionId).catch((error: unknown) => {
        logger.debug("background_cache_failed", {
          trackId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return opened;
  }

  private async openFile(target: string, startSec: number): Promise<OpenedStream> {
    const decoded = this.deps.toPcmFromFile(target, {
      ffmpegPath: this.ffmpegPath,
      startSec,
      normalization: this.normalization,
    });
    return this.finishOpened(decoded.stream, decoded.kill, this.cachePrebufferBytes, "cache");
  }

  private async openStream(track: MediaTrack, startSec: number): Promise<OpenedStream> {
    const ytdlp = await this.deps.openAudioStream(track, {
      startSec,
      options: this.ytdlpOptions,
    });
    const pcm = this.deps.toPcm(ytdlp.stream, {
      ffmpegPath: this.ffmpegPath,
      normalization: this.normalization,
    });
    const stopYtdlp = (): void => {
      if (ytdlp.process.exitCode === null) {
        try {
          ytdlp.process.kill("SIGKILL");
        } catch {
          // Process already gone.
        }
      }
    };
    return this.finishOpened(
      pcm,
      () => {
        stopYtdlp();
        pcm.destroy();
      },
      this.streamPrebufferBytes,
      "stream",
    );
  }

  private async finishOpened(
    pcm: Readable,
    stopDecoder: () => void,
    prebufferBytes: number,
    source: "cache" | "stream",
  ): Promise<OpenedStream> {
    const output = new PassThrough();
    let stopped = false;

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      stopDecoder();
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
      const chunks = await readFirstChunks(pcm, prebufferBytes, this.prebufferTimeoutMs);
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

    return { stream: output, stop, source };
  }

  private trackId(track: MediaTrack): string {
    return track.videoId ?? track.id ?? track.url;
  }

  private cacheKey(sessionId: string, track: MediaTrack): string {
    return `${sessionId}:${this.trackId(track)}`;
  }

  private cacheable(track: MediaTrack): boolean {
    return !track.isLive && track.durationSec !== null && track.durationSec !== undefined;
  }
}
