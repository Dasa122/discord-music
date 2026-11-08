import type { ResolvedTrack } from "../ytdlp.js";

export interface ResolveOptions {
  /** Lets a resolver use the session cache; the yt-dlp one does not need it. */
  sessionId?: string;
}

/**
 * One way to turn a query into tracks. The player only ever talks to this
 * interface, so the innertube and yt-dlp paths stay interchangeable and the
 * feature flag is a single selection at construction time.
 */
export interface TrackResolver {
  resolve(query: string, opts?: ResolveOptions): Promise<ResolvedTrack>;
  resolveSearch(query: string, limit: number): Promise<ResolvedTrack[]>;
  /**
   * True when `resolve()` may return a signed `streamUrl` that can be played
   * without yt-dlp. The media engine uses this to decide whether re-resolving
   * a truncated track can resume it at an offset.
   */
  readonly providesStreamUrls?: boolean;
}

/**
 * The query cannot be handled by this resolver at all — a non-YouTube URL, a
 * playlist, a protocol yt-dlp understands and innertube does not. It is not a
 * failure of the service, so the circuit breaker must not count it.
 */
export class UnsupportedQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedQueryError";
  }
}
