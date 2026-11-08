import { PassThrough, type Readable } from "node:stream";
import { MediaError } from "../errors.js";
import { logger } from "../logger.js";
import type { AudioCache } from "./audio-cache.js";
import type { DownloadReporter } from "./download-registry.js";
import {
  analyzeLoudness,
  computeGainDb,
  DEFAULT_LOUDNESS_SETTINGS,
  DEFAULT_MAX_GAIN_DB,
  DEFAULT_STREAM_FILTER,
  type LoudnessMeasurement,
  type LoudnessSettings,
  type PlaybackAudioConfig,
  type StreamFilterMode,
  selectPlaybackFilter,
  toPcm,
  toPcmFromFile,
  toPcmFromUrl,
} from "./ffmpeg.js";
import { QueuedSemaphore } from "./limits.js";
import {
  buildTrackSearchQuery,
  DEFAULT_MUSIC_LINK_MAX_TRACKS,
  type DetectedMusicLink,
  MusicLinkError,
  type MusicLinkResolution,
  type ProviderTrack,
  providerArtist,
} from "./providers/index.js";
import { type CachedResolution, ResolveCache } from "./resolve-cache.js";
import type { TrackResolver } from "./resolver/types.js";
import { createYtdlpResolver } from "./resolver/ytdlp-resolver.js";
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

/** 48 kHz stereo s16le: 48 × 2 channels × 2 bytes per sample. */
export const PCM_BYTES_PER_MS = 48 * 2 * 2;
/** 250 ms of decoded PCM; a local file needs almost no head start. */
export const CACHE_PREBUFFER_MS = 250;
export const CACHE_PREBUFFER_BYTES = CACHE_PREBUFFER_MS * PCM_BYTES_PER_MS;
/** Default start buffer for the yt-dlp pipe; overridable with STREAM_PREBUFFER_MS. */
export const DEFAULT_STREAM_PREBUFFER_MS = 250;
export const STREAM_PREBUFFER_BYTES = DEFAULT_STREAM_PREBUFFER_MS * PCM_BYTES_PER_MS;
export const DEFAULT_PREBUFFER_TIMEOUT_MS = 15_000;

/** A stream prebuffer that produces nothing within this multiple falls back to piping. */
export const STREAM_PREBUFFER_TIMEOUT_FACTOR = 4;

/** A direct-URL ffmpeg exit inside this window is treated as a stale URL. */
export const STREAM_URL_FAST_FAIL_MS = 5_000;

/** One queued stream URL per resolved track; the oldest is evicted past this. */
export const MAX_PENDING_STREAMS = 64;

/**
 * Is a failed direct-URL attempt worth one re-resolve? An explicit 403/410 from
 * googlevideo means the signed URL expired or was minted for another client;
 * any other fast non-zero exit (bad manifest, rejected UA) may also be cured by
 * a fresh URL. Anything slower is a network problem and belongs on yt-dlp.
 */
export function isRetryableStreamUrlFailure(message: string, elapsedMs: number): boolean {
  if (/\b(403|410)\b/.test(message)) return true;
  return elapsedMs < STREAM_URL_FAST_FAIL_MS && /ffmpeg exited with code/i.test(message);
}

/** A signed media URL handed from `resolve()` to the play that follows it. */
interface PendingStream {
  url: string;
  headers?: Record<string, string>;
}

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
  /** Receives download state for the background cache job this open starts. */
  downloads?: DownloadReporter;
  /**
   * Mint a fresh stream URL instead of the one-shot pending one. Used by
   * truncation recovery, where the original URL stopped mid-track.
   */
  refreshStreamUrl?: boolean;
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
  ensureCached?(track: MediaTrack, sessionId?: string, downloads?: DownloadReporter): Promise<void>;
  prefetch?(track: MediaTrack, sessionId?: string, downloads?: DownloadReporter): Promise<void>;
  /** `trackId` narrows the cancellation to one track's pending job. */
  cancelPrefetch?(sessionId?: string, trackId?: string): void;
  pin?(sessionId: string, trackId: string): Promise<void>;
  unpin?(sessionId: string, trackId: string): Promise<void>;
  releaseSession?(sessionId: string): Promise<void>;
  /** Bytes of the complete cached file, or `null` when it is not cached. */
  cachedBytes?(track: MediaTrack, sessionId?: string): number | null;
  /** Whether `open(..., { refreshStreamUrl: true })` can mint a new URL. */
  providesStreamUrls?(): boolean;
}

export interface MediaEngineDeps {
  downloadAudio: typeof downloadAudio;
  openAudioStream: typeof openAudioStream;
  resolve: typeof resolve;
  resolveSearch: typeof resolveSearch;
  toPcm: typeof toPcm;
  toPcmFromFile: typeof toPcmFromFile;
  toPcmFromUrl: typeof toPcmFromUrl;
  analyzeLoudness: typeof analyzeLoudness;
}

/**
 * The music-link seam: `MusicLinkResolver` implements it, and tests can supply
 * one without a network.
 */
export interface MusicLinkSource {
  parse(query: string): DetectedMusicLink | null;
  resolve(query: string, maxTracks?: number): Promise<MusicLinkResolution>;
}

/** Exact gain measured for one cached track. */
export interface TrackMeasurement {
  gainDb: number;
  inputLufs: number;
}

export interface YtdlpMediaEngineOptions {
  ytdlp: YtdlpOptions;
  ffmpegPath: string;
  /** Applied to every decoded track on both the stream and cached-file paths. */
  normalization?: LoudnessSettings;
  /**
   * Filter for the streamed first play (default `limiter`). A cached track
   * with a measurement always overrides this with its exact gain.
   */
  streamFilter?: StreamFilterMode;
  /** Measure cached tracks once so replays use an exact gain (default on). */
  twoPass?: boolean;
  /** Symmetric bound on the measured gain, in dB. */
  maxGainDb?: number;
  cache?: AudioCache | null;
  prefetchEnabled?: boolean;
  prefetchMaxConcurrent?: number;
  maxCacheFileBytes?: number;
  cachePrebufferBytes?: number;
  /** Default start buffer for the stream path, in milliseconds. */
  streamPrebufferMs?: number;
  prebufferTimeoutMs?: number;
  /** Shared across engines; injectable so a test can use a controlled clock. */
  resolveCache?: ResolveCache;
  /**
   * Where resolved metadata comes from. Defaults to the yt-dlp wrapper, so the
   * pre-P2 behaviour is unchanged when RESOLVER is unset.
   */
  resolver?: TrackResolver;
  /** Spotify/Apple Music link resolution; disabled when omitted. */
  musicLinks?: MusicLinkSource;
  /** Cap applied to a provider collection (MUSIC_LINK_MAX_TRACKS). */
  musicLinkMaxTracks?: number;
  deps?: Partial<MediaEngineDeps>;
}

/** Wait for ffmpeg's exit report, but never block a failure path on it. */
const EXIT_WAIT_MS = 2_000;

function raceExit(
  exit: Promise<{ code: number | null; stderr: string }>,
): Promise<{ code: number | null; stderr: string } | null> {
  return Promise.race([
    exit,
    new Promise<null>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(null), EXIT_WAIT_MS);
      timer.unref?.();
    }),
  ]);
}

function readFirstChunks(
  stream: Readable,
  minBytes: number,
  timeoutMs: number,
  options: { fallbackOnTimeout?: boolean } = {},
): Promise<Buffer[] | null> {
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
      if (bytes > 0) {
        finish();
      } else if (options.fallbackOnTimeout) {
        // A slow extractor must not fail the track: hand the pipe straight to
        // the player and let it buffer there instead.
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(null);
      } else {
        fail(new MediaError("EXTRACTOR_FAILED", "Timed out waiting for audio."));
      }
    }, timeoutMs);
    timer.unref?.();

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

/** "Spotify playlist" / "Apple Music album" when the API exposed no name. */
function collectionFallbackTitle(resolution: MusicLinkResolution): string {
  const label = resolution.provider === "spotify" ? "Spotify" : "Apple Music";
  return `${label} ${resolution.kind}`;
}

/**
 * Rebuild a playable `ResolvedTrack` from cached metadata. Only the canonical
 * video id is cached, so the page URL is derived here instead of a signed
 * stream URL ever being persisted.
 */
function materializeResolvedTrack(entry: CachedResolution, fallbackUrl: string): ResolvedTrack {
  const webpageUrl = entry.videoId
    ? `https://www.youtube.com/watch?v=${entry.videoId}`
    : fallbackUrl.trim();
  const track: ResolvedTrack = {
    videoId: entry.videoId,
    title: entry.title,
    artist: entry.artist ?? null,
    webpageUrl,
    durationSec: entry.durationSec,
    thumbnailUrl: entry.thumbnailUrl,
    isPlaylist: entry.isPlaylist,
  };
  if (entry.entries) {
    track.entries = entry.entries.map((child) => materializeResolvedTrack(child, webpageUrl));
  }
  return track;
}

export class YtdlpMediaEngine implements MediaEngine {
  private readonly ytdlpOptions: YtdlpOptions;
  private readonly ffmpegPath: string;
  private readonly normalization: LoudnessSettings | undefined;
  private readonly streamFilter: StreamFilterMode;
  private readonly twoPass: boolean;
  private readonly maxGainDb: number;
  private readonly cache: AudioCache | null;
  private readonly prefetchEnabled: boolean;
  private readonly prefetchSemaphore: QueuedSemaphore;
  private readonly maxCacheFileBytes: number;
  private readonly cachePrebufferBytes: number;
  private readonly streamPrebufferMs: number;
  private readonly prebufferTimeoutMs: number;
  private readonly resolveCache: ResolveCache;
  private readonly resolver: TrackResolver;
  private readonly musicLinks: MusicLinkSource | null;
  private readonly musicLinkMaxTracks: number;
  private readonly deps: MediaEngineDeps;

  private readonly preparing = new Map<string, Promise<void>>();
  private readonly prepareAborts = new Map<string, AbortController>();
  private readonly preparedInfoByKey = new Map<string, TrackInfo>();
  private readonly measurementByKey = new Map<string, TrackMeasurement>();
  private readonly prefetching = new Map<string, Promise<void>>();
  private readonly prefetchAborts = new Map<string, AbortController>();
  /**
   * Signed stream URLs keyed by track id, written by `resolve()` and consumed
   * by exactly one `open()`. Never persisted, never sent to the client: a
   * googlevideo URL is IP/UA-bound and expires.
   */
  private readonly pendingStreams = new Map<string, PendingStream>();

  constructor(options: YtdlpMediaEngineOptions) {
    this.ytdlpOptions = options.ytdlp;
    this.ffmpegPath = options.ffmpegPath;
    this.normalization = options.normalization;
    this.streamFilter = options.streamFilter ?? DEFAULT_STREAM_FILTER;
    this.twoPass = options.twoPass ?? true;
    this.maxGainDb = options.maxGainDb ?? DEFAULT_MAX_GAIN_DB;
    this.cache = options.cache ?? null;
    this.prefetchEnabled = options.prefetchEnabled ?? true;
    this.prefetchSemaphore = new QueuedSemaphore(
      Math.max(1, Math.min(4, options.prefetchMaxConcurrent ?? 2)),
      60_000,
    );
    this.maxCacheFileBytes = options.maxCacheFileBytes ?? 67_108_864;
    this.cachePrebufferBytes = options.cachePrebufferBytes ?? CACHE_PREBUFFER_BYTES;
    this.streamPrebufferMs = options.streamPrebufferMs ?? DEFAULT_STREAM_PREBUFFER_MS;
    this.prebufferTimeoutMs = options.prebufferTimeoutMs ?? DEFAULT_PREBUFFER_TIMEOUT_MS;
    this.resolveCache = options.resolveCache ?? new ResolveCache();
    this.musicLinks = options.musicLinks ?? null;
    this.musicLinkMaxTracks = Math.max(
      1,
      Math.min(100, options.musicLinkMaxTracks ?? DEFAULT_MUSIC_LINK_MAX_TRACKS),
    );
    this.deps = {
      downloadAudio,
      openAudioStream,
      resolve,
      resolveSearch,
      toPcm,
      toPcmFromFile,
      toPcmFromUrl,
      analyzeLoudness,
      ...options.deps,
    };
    this.resolver =
      options.resolver ??
      createYtdlpResolver({
        options: this.ytdlpOptions,
        resolve: this.deps.resolve,
        resolveSearch: this.deps.resolveSearch,
      });
  }

  async resolve(query: string, sessionId?: string): Promise<ResolvedTrack> {
    const cached = sessionId ? this.cachedResolution(query, sessionId) : null;
    if (cached) {
      logger.debug("resolve_source", { source: "cache" });
      return cached;
    }

    const memoized = this.resolveCache.get(query);
    logger.debug("resolve_cache", this.resolveCache.stats());
    if (memoized) {
      logger.debug("resolve_source", { source: "resolve_cache" });
      return materializeResolvedTrack(memoized, query);
    }

    logger.debug("resolve_source", { source: "extractor" });

    // A Spotify/Apple Music link is resolved here, before the URL guard (which
    // only admits media hosts) and before any yt-dlp call.
    const musicLink = this.musicLinks?.parse(query) ?? null;
    if (musicLink) return await this.resolveMusicLink(query, musicLink);

    const resolved = await this.resolver.resolve(query, { sessionId });
    // Failures are never cached: a transient extractor error must not stick.
    this.resolveCache.set(query, resolved);
    this.rememberStream(resolved);
    return resolved;
  }

  /**
   * Map a provider link to playable YouTube tracks. Each source track either
   * already carries a YouTube id (song.link fast path) or costs exactly one
   * search; the queue keeps the source title/artist/thumbnail either way.
   */
  private async resolveMusicLink(
    query: string,
    detected: DetectedMusicLink,
  ): Promise<ResolvedTrack> {
    const musicLinks = this.musicLinks;
    if (!musicLinks) throw new MediaError("EXTRACTOR_FAILED", "Music links are not configured.");

    const startedAt = Date.now();
    let resolution: MusicLinkResolution;
    try {
      resolution = await musicLinks.resolve(query, this.musicLinkMaxTracks);
    } catch (error) {
      const message =
        error instanceof MusicLinkError
          ? error.message
          : error instanceof Error && error.message
            ? error.message
            : "Could not resolve that music link.";
      logger.warn("provider_resolve_failed", {
        provider: detected.provider,
        kind: detected.kind,
        error: message,
      });
      throw new MediaError("EXTRACTOR_FAILED", message);
    }

    const searchStartedAt = Date.now();
    const settled = await Promise.allSettled(
      resolution.tracks
        .slice(0, this.musicLinkMaxTracks)
        .map((track) => this.resolveProviderTrack(track)),
    );
    const searchMs = Date.now() - searchStartedAt;

    const entries: ResolvedTrack[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") entries.push(result.value);
    }
    const failed = settled.length - entries.length;
    if (failed > 0) {
      logger.debug("provider_track_skipped", {
        provider: resolution.provider,
        count: failed,
      });
    }
    if (entries.length === 0) {
      throw new MediaError("NOT_FOUND", "No YouTube matches were found for that link.");
    }

    const single = resolution.kind === "track" && entries.length === 1;
    const resolved: ResolvedTrack = single
      ? (entries[0] as ResolvedTrack)
      : {
          videoId: null,
          title: resolution.title ?? collectionFallbackTitle(resolution),
          webpageUrl: query.trim(),
          durationSec: null,
          thumbnailUrl: null,
          isPlaylist: true,
          entries,
        };

    this.resolveCache.set(query, resolved);
    this.rememberStream(resolved);
    logger.debug("provider_resolved", {
      provider: resolution.provider,
      kind: resolution.kind,
      tracks: entries.length,
      searchMs,
      totalMs: Date.now() - startedAt,
    });
    return resolved;
  }

  private async resolveProviderTrack(track: ProviderTrack): Promise<ResolvedTrack> {
    const artist = providerArtist(track);
    if (track.youtubeVideoId) {
      return {
        videoId: track.youtubeVideoId,
        title: track.title,
        artist,
        webpageUrl: `https://www.youtube.com/watch?v=${track.youtubeVideoId}`,
        durationSec: track.durationSec,
        thumbnailUrl: track.thumbnailUrl,
        isPlaylist: false,
      };
    }

    const hits = await this.resolver.resolveSearch(buildTrackSearchQuery(track), 1);
    const hit = hits[0];
    const videoId = hit?.videoId ?? (hit ? youtubeVideoIdFromUrl(hit.webpageUrl) : null);
    if (!hit || !videoId) {
      throw new MediaError("NOT_FOUND", `No YouTube match found for "${track.title}".`);
    }
    return {
      videoId,
      title: track.title,
      artist,
      webpageUrl: hit.webpageUrl || `https://www.youtube.com/watch?v=${videoId}`,
      durationSec: track.durationSec ?? hit.durationSec,
      thumbnailUrl: track.thumbnailUrl ?? hit.thumbnailUrl,
      isPlaylist: false,
    };
  }

  async resolveSearch(query: string, limit: number): Promise<ResolvedTrack[]> {
    const results = await this.resolver.resolveSearch(query, limit);
    for (const result of results) this.rememberStream(result);
    return results;
  }

  private rememberStream(track: ResolvedTrack): void {
    if (track.streamUrl) {
      const key = track.videoId ?? track.webpageUrl;
      if (!this.pendingStreams.has(key) && this.pendingStreams.size >= MAX_PENDING_STREAMS) {
        const oldest = this.pendingStreams.keys().next();
        if (!oldest.done) this.pendingStreams.delete(oldest.value);
      }
      this.pendingStreams.set(key, {
        url: track.streamUrl,
        ...(track.headers ? { headers: track.headers } : {}),
      });
    }
    for (const entry of track.entries ?? []) this.rememberStream(entry);
  }

  /** The one-shot hand-off for this play; a second play re-resolves. */
  private takeStream(track: MediaTrack): PendingStream | null {
    const key = this.trackId(track);
    const pending = this.pendingStreams.get(key);
    if (!pending) return null;
    this.pendingStreams.delete(key);
    return pending;
  }

  /**
   * Mint a fresh URL for a track whose transfer stopped mid-play. Failure is
   * not fatal: `openStream` falls back to the yt-dlp pipe, which is the next
   * step of the truncation recovery anyway.
   */
  private async refreshStream(track: MediaTrack): Promise<PendingStream | null> {
    if (!this.providesStreamUrls()) return null;
    try {
      const resolved = await this.resolver.resolve(track.url);
      if (!resolved.streamUrl) return null;
      logger.debug("stream_url_refreshed", { trackId: this.trackId(track) });
      return {
        url: resolved.streamUrl,
        ...(resolved.headers ? { headers: resolved.headers } : {}),
      };
    } catch (error) {
      logger.warn("stream_url_refresh_failed", {
        trackId: this.trackId(track),
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 240),
      });
      return null;
    }
  }

  cachedBytes(track: MediaTrack, sessionId?: string): number | null {
    if (!this.cache || !sessionId) return null;
    return this.cache.cachedBytes(sessionId, this.trackId(track));
  }

  providesStreamUrls(): boolean {
    return this.resolver.providesStreamUrls === true;
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
  async prefetch(
    track: MediaTrack,
    sessionId?: string,
    downloads?: DownloadReporter,
  ): Promise<void> {
    if (!this.prefetchEnabled || !sessionId) return;
    await this.requestCacheJob(track, sessionId, "prefetch", downloads);
  }

  /**
   * Fill the cache for a track that is already streaming. Fire-and-forget by
   * contract: the live stream is never replaced, and a failure is only logged.
   */
  async ensureCached(
    track: MediaTrack,
    sessionId?: string,
    downloads?: DownloadReporter,
  ): Promise<void> {
    if (!sessionId) return;
    await this.requestCacheJob(track, sessionId, "background", downloads);
  }

  private requestCacheJob(
    track: MediaTrack,
    sessionId: string,
    kind: "prefetch" | "background",
    downloads?: DownloadReporter,
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
    const run = this.runCacheJob(track, id, sessionId, key, controller, kind, downloads).finally(
      () => {
        this.prefetching.delete(key);
        this.prefetchAborts.delete(key);
      },
    );

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
    downloads?: DownloadReporter,
  ): Promise<void> {
    let release: (() => void) | null = null;
    downloads?.begin(sessionId, id, track.title ?? track.url);
    try {
      release = await this.prefetchSemaphore.acquire(
        () => new MediaError("DOWNLOAD_FAILED", "The prefetch queue is full."),
      );
      await this.cache?.claim(sessionId, id);
      if (this.cache?.has(sessionId, id)) {
        downloads?.ready(id, {
          bytes: this.cache.cachedBytes(sessionId, id) ?? 0,
          gainDb: this.measurementByKey.get(key)?.gainDb ?? null,
        });
        return;
      }

      const dir = this.cache?.tempDirFor(sessionId);
      if (!this.cache || !dir) {
        downloads?.fail(id, "DOWNLOAD_FAILED");
        return;
      }
      const produced = await this.deps.downloadAudio(track, dir, {
        signal: controller.signal,
        maxBytes: this.maxCacheFileBytes,
        onProgress: downloads
          ? (progress) =>
              downloads.progress(id, {
                bytes: progress.downloadedBytes,
                totalBytes: progress.totalBytes,
              })
          : undefined,
      });
      if (produced.info) this.preparedInfoByKey.set(key, produced.info);
      const measurement = await this.measureTrack(produced.path, id);
      if (measurement) this.measurementByKey.set(key, measurement);
      await this.cache.storeFile(sessionId, id, produced.path);
      downloads?.ready(id, {
        bytes: this.cache.cachedBytes(sessionId, id) ?? 0,
        gainDb: measurement?.gainDb ?? null,
      });
      if (kind === "background") {
        logger.debug("background_cache_completed", { trackId: id });
      }
    } catch (error) {
      downloads?.fail(
        id,
        controller.signal.aborted
          ? "ABORTED"
          : error instanceof MediaError
            ? error.code
            : "DOWNLOAD_FAILED",
      );
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

  /**
   * Measure a downloaded file before it is uploaded/deleted. Best-effort: a
   * failed analysis only costs the exact gain, never the cached copy.
   */
  private async measureTrack(filePath: string, trackId: string): Promise<TrackMeasurement | null> {
    const settings = this.normalization ?? DEFAULT_LOUDNESS_SETTINGS;
    if (!this.twoPass || settings.mode === "off") return null;

    let measurement: LoudnessMeasurement | null = null;
    try {
      measurement = await this.deps.analyzeLoudness(filePath, settings, {
        ffmpegPath: this.ffmpegPath,
      });
    } catch {
      measurement = null;
    }
    if (!measurement) return null;

    const gainDb = computeGainDb(
      measurement.inputLufs,
      measurement.inputTp,
      settings.targetLufs,
      settings.truePeakDb,
      this.maxGainDb,
    );
    logger.debug("loudness_analyzed", {
      trackId,
      inputLufs: measurement.inputLufs,
      inputTp: measurement.inputTp,
      gainDb,
    });
    return { gainDb, inputLufs: measurement.inputLufs };
  }

  cancelPrefetch(sessionId?: string, trackId?: string): void {
    for (const [key, controller] of this.prefetchAborts) {
      if (sessionId && !key.startsWith(`${sessionId}:`)) continue;
      if (trackId && !key.endsWith(`:${trackId}`)) continue;
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
    for (const key of [...this.measurementByKey.keys()]) {
      if (key.startsWith(`${sessionId}:`)) this.measurementByKey.delete(key);
    }
    await this.cache?.releaseSession(sessionId);
  }

  /** Loudness settings plus the stream mode, as the filter builder expects. */
  private playbackConfig(): PlaybackAudioConfig {
    return {
      ...(this.normalization ?? DEFAULT_LOUDNESS_SETTINGS),
      streamFilter: this.streamFilter,
    };
  }

  async open(track: MediaTrack, options: OpenTrackOptions = {}): Promise<OpenedStream> {
    const startSec = options.startSec ?? 0;
    const id = this.trackId(track);
    const openStartedAt = Date.now();
    // Consumed here so a cache hit discards it and a second play re-resolves:
    // the URL lives for exactly one open.
    const pending = this.takeStream(track);

    if (this.cache && options.sessionId && !track.isLive) {
      if (this.cache.has(options.sessionId, id)) {
        try {
          const target = await this.cache.target(options.sessionId, id);
          if (target) {
            const measurement = this.measurementByKey.get(this.cacheKey(options.sessionId, track));
            const selected = selectPlaybackFilter({
              config: this.playbackConfig(),
              source: "cache",
              hasMeasurement: measurement !== undefined,
              gainDb: measurement?.gainDb,
            });
            logger.debug("play_filter", {
              source: "cache",
              filter: selected.kind,
              ...(selected.kind === "measured" ? { gainDb: selected.gainDb } : {}),
            });
            logger.info("play_source", {
              source: "cache",
              trackId: id,
              cachedBytes: this.cache.cachedBytes(options.sessionId, id) ?? undefined,
            });
            const opened = await this.openFile(target, startSec, selected.filter, id);
            logger.debug("open_ms", {
              ms: Date.now() - openStartedAt,
              source: "cache",
              trackId: id,
            });
            return opened;
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
    const selected = selectPlaybackFilter({
      config: this.playbackConfig(),
      source: "stream",
      hasMeasurement: false,
    });
    logger.debug("play_filter", { source: "stream", filter: selected.kind });
    // A truncation resume asks for a fresh URL; everything else uses the
    // one-shot URL handed over by resolve().
    const streamPending =
      pending ?? (options.refreshStreamUrl ? await this.refreshStream(track) : null);
    const opened = await this.openStream(track, startSec, selected.filter, id, streamPending);
    logger.info("play_source", { source: "stream", trackId: id });
    logger.debug("open_ms", { ms: Date.now() - openStartedAt, source: "stream", trackId: id });

    if (this.cache && options.sessionId) {
      void this.ensureCached(track, options.sessionId, options.downloads).catch(
        (error: unknown) => {
          logger.debug("background_cache_failed", {
            trackId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    }

    return opened;
  }

  private async openFile(
    target: string,
    startSec: number,
    filter: string | null,
    trackId: string,
  ): Promise<OpenedStream> {
    const decoded = this.deps.toPcmFromFile(target, {
      ffmpegPath: this.ffmpegPath,
      startSec,
      filter,
      normalization: this.normalization,
    });
    return this.finishOpened({
      pcm: decoded.stream,
      stopDecoder: decoded.kill,
      prebufferBytes: this.cachePrebufferBytes,
      source: "cache",
      timeoutMs: this.prebufferTimeoutMs,
      fallbackOnTimeout: false,
      trackId,
    });
  }

  private async openStream(
    track: MediaTrack,
    startSec: number,
    filter: string | null,
    trackId: string,
    pending: PendingStream | null,
  ): Promise<OpenedStream> {
    if (pending) {
      const fromUrl = await this.openUrlWithRetry(track, pending, startSec, filter, trackId);
      if (fromUrl) return fromUrl;
    }

    const ytdlp = await this.deps.openAudioStream(track, {
      startSec,
      options: this.ytdlpOptions,
    });
    const pcm = this.deps.toPcm(ytdlp.stream, {
      ffmpegPath: this.ffmpegPath,
      filter,
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
    return this.finishOpened({
      pcm,
      stopDecoder: () => {
        stopYtdlp();
        pcm.destroy();
      },
      prebufferBytes: Math.round(this.streamPrebufferMs * PCM_BYTES_PER_MS),
      source: "stream",
      timeoutMs: this.streamPrebufferMs * STREAM_PREBUFFER_TIMEOUT_FACTOR,
      fallbackOnTimeout: true,
      trackId,
    });
  }

  /**
   * Play straight from the resolver's googlevideo URL. A stale URL is re-minted
   * once, and if that fails too the caller falls back to the yt-dlp pipe — a
   * resolver failure must never fail the command.
   */
  private async openUrlWithRetry(
    track: MediaTrack,
    pending: PendingStream,
    startSec: number,
    filter: string | null,
    trackId: string,
  ): Promise<OpenedStream | null> {
    const startedAt = Date.now();
    try {
      logger.debug("play_transport", { trackId, transport: "url" });
      return await this.openFromUrl(pending, startSec, filter, trackId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const elapsedMs = Date.now() - startedAt;
      if (!isRetryableStreamUrlFailure(reason, elapsedMs)) {
        // Not something a fresh URL can cure (missing ffmpeg, broken network).
        // The URL path is an optimisation, never a dependency: degrade instead
        // of failing a command that yt-dlp can still serve.
        logger.warn("stream_url_fallback", { trackId, reason: reason.slice(0, 240) });
        return null;
      }
      logger.warn("stream_url_retry", {
        trackId,
        elapsedMs,
        reason: reason.slice(0, 240),
      });
    }

    try {
      const refreshed = await this.resolver.resolve(track.url);
      if (refreshed.streamUrl) {
        return await this.openFromUrl(
          {
            url: refreshed.streamUrl,
            ...(refreshed.headers ? { headers: refreshed.headers } : {}),
          },
          startSec,
          filter,
          trackId,
        );
      }
      logger.warn("stream_url_fallback", { trackId, reason: "no_refreshed_url" });
    } catch (error) {
      logger.warn("stream_url_fallback", {
        trackId,
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 240),
      });
    }
    return null;
  }

  private async openFromUrl(
    pending: PendingStream,
    startSec: number,
    filter: string | null,
    trackId: string,
  ): Promise<OpenedStream> {
    const decoded = this.deps.toPcmFromUrl(pending.url, pending.headers, {
      ffmpegPath: this.ffmpegPath,
      startSec,
      filter,
      normalization: this.normalization,
    });
    try {
      return await this.finishOpened({
        pcm: decoded.stream,
        stopDecoder: decoded.kill,
        prebufferBytes: Math.round(this.streamPrebufferMs * PCM_BYTES_PER_MS),
        source: "stream",
        timeoutMs: this.streamPrebufferMs * STREAM_PREBUFFER_TIMEOUT_FACTOR,
        fallbackOnTimeout: true,
        trackId,
      });
    } catch (error) {
      // A failed HTTP open closes stdout before ffmpeg reports why, so the
      // "no audio" error alone cannot tell a stale URL from an empty file.
      // Fold ffmpeg's own exit code and stderr back into the message.
      const exit = decoded.exit ? await raceExit(decoded.exit) : null;
      if (!exit || (exit.code === 0 && !exit.stderr.trim())) throw error;
      const detail = exit.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .pop();
      const base = error instanceof Error ? error.message : String(error);
      throw new MediaError(
        "EXTRACTOR_FAILED",
        `${base} (ffmpeg exit ${exit.code ?? "null"}${detail ? `: ${detail}` : ""})`,
      );
    }
  }

  private async finishOpened(input: {
    pcm: Readable;
    stopDecoder: () => void;
    prebufferBytes: number;
    source: "cache" | "stream";
    timeoutMs: number;
    fallbackOnTimeout: boolean;
    trackId: string;
  }): Promise<OpenedStream> {
    const { pcm, stopDecoder, prebufferBytes, source, timeoutMs, fallbackOnTimeout, trackId } =
      input;
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
    // The decoder error is already surfaced by the prebuffer awaiting below;
    // this listener only stops Node from treating it as unhandled.
    output.on("error", () => {});
    output.on("close", () => {
      if (!stopped) stop();
    });

    const prebufferStartedAt = Date.now();
    try {
      const chunks = await readFirstChunks(pcm, prebufferBytes, timeoutMs, {
        fallbackOnTimeout,
      });
      logger.debug("prebuffer_ms", {
        ms: Date.now() - prebufferStartedAt,
        source,
        trackId,
        ...(chunks === null ? { fellBack: true } : {}),
      });
      // `null` means the stream produced nothing within its window; piping it
      // straight through is the pre-P1 behaviour and still plays once bytes
      // arrive.
      for (const chunk of chunks ?? []) output.write(chunk);
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
