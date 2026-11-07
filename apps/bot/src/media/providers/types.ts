/** A platform whose links we can turn into YouTube playback. */
export type ProviderId = "spotify" | "applemusic";

/** What a pasted link points at. */
export type ProviderKind = "track" | "album" | "playlist";

/** One source track, before it is matched to a YouTube video. */
export interface ProviderTrack {
  title: string;
  artists: string[];
  durationSec: number | null;
  thumbnailUrl: string | null;
  /** The link this metadata came from (a Spotify/Apple track or collection URL). */
  sourceUrl: string;
  provider: ProviderId;
  /** Set when a lookup already answered with a playable YouTube video. */
  youtubeVideoId?: string;
}

export interface ProviderResolution {
  provider: ProviderId;
  kind: ProviderKind;
  /** Album/playlist name, when the provider exposed one. */
  title?: string;
  tracks: ProviderTrack[];
}

/** The one seam the media engine needs; `MusicLinkResolver` implements it. */
export interface MusicLinkProvider {
  readonly id: ProviderId;
  matches(url: URL): boolean;
  /** `maxTracks` caps collection expansion; singles ignore it. */
  resolve(url: URL, maxTracks?: number): Promise<ProviderResolution>;
}

export type MusicLinkErrorCode =
  | "TRACK_NOT_FOUND"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_AUTH_REQUIRED"
  | "PROVIDER_UNAVAILABLE";

/**
 * A music-link lookup failed. These are expected outcomes (a deleted track, a
 * rate limit, missing credentials) with messages fit to send to Discord.
 */
export class MusicLinkError extends Error {
  readonly code: MusicLinkErrorCode;
  readonly provider: ProviderId | undefined;

  constructor(code: MusicLinkErrorCode, message: string, provider?: ProviderId) {
    super(message);
    this.name = "MusicLinkError";
    this.code = code;
    this.provider = provider;
  }
}

/** Injectable `fetch` so every provider is testable without a network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const MUSIC_LINK_REQUEST_TIMEOUT_MS = 10_000;
