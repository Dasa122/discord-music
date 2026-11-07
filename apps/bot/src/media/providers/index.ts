import { createAppleMusicProvider } from "./applemusic.js";
import { type DetectedMusicLink, parseMusicLink } from "./detect.js";
import { OdesliClient } from "./odesli.js";
import { createSpotifyProvider } from "./spotify.js";
import {
  type FetchLike,
  MusicLinkError,
  type MusicLinkProvider,
  type ProviderId,
  type ProviderKind,
  type ProviderTrack,
} from "./types.js";

export type { DetectedMusicLink } from "./detect.js";
export { detectMusicLink, parseMusicLink } from "./detect.js";
export { OdesliClient, parseOdesliPayload } from "./odesli.js";
export { MISSING_CREDENTIALS_MESSAGE } from "./spotify.js";
export {
  type FetchLike,
  MusicLinkError,
  type MusicLinkErrorCode,
  type ProviderId,
  type ProviderKind,
  type ProviderTrack,
} from "./types.js";

export const DEFAULT_MUSIC_LINK_MAX_TRACKS = 50;
export const MAX_MUSIC_LINK_TRACKS = 100;

export interface MusicLinkResolution {
  provider: ProviderId;
  kind: ProviderKind;
  title?: string;
  tracks: ProviderTrack[];
}

export interface MusicLinkResolverOptions {
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  appleUserAgent?: string;
  /** Applied when `resolve()` is called without an explicit cap. */
  maxTracks?: number;
}

function clampTracks(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MUSIC_LINK_MAX_TRACKS;
  return Math.max(1, Math.min(MAX_MUSIC_LINK_TRACKS, Math.floor(value)));
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * The YouTube search for a source track: `"<title> <artist>"` with every artist
 * joined, trimmed and free of doubled spaces.
 */
export function buildTrackSearchQuery(track: Pick<ProviderTrack, "title" | "artists">): string {
  const title = normalizeText(track.title);
  const artists = normalizeText(track.artists.map(normalizeText).filter(Boolean).join(" "));
  return normalizeText([title, artists].filter(Boolean).join(" "));
}

/** Source artists as one queue/embed string, or `null` when there are none. */
export function providerArtist(track: Pick<ProviderTrack, "artists">): string | null {
  const artists = normalizeText(track.artists.map(normalizeText).filter(Boolean).join(", "));
  return artists === "" ? null : artists;
}

/**
 * Spotify and Apple Music links → source metadata → (later) YouTube playback.
 *
 * Resolution order per provider: song.link first when it already answers with a
 * YouTube link (no search needed), else the provider API / JSON-LD, then the
 * media engine searches YouTube for any track still without a video id.
 */
export class MusicLinkResolver {
  private readonly providers: Record<ProviderId, MusicLinkProvider>;
  private readonly defaultMaxTracks: number;

  constructor(options: MusicLinkResolverOptions = {}) {
    const odesli = new OdesliClient({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    this.providers = {
      spotify: createSpotifyProvider({
        ...(options.spotifyClientId ? { clientId: options.spotifyClientId } : {}),
        ...(options.spotifyClientSecret ? { clientSecret: options.spotifyClientSecret } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        odesli,
      }),
      applemusic: createAppleMusicProvider({
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.appleUserAgent ? { userAgent: options.appleUserAgent } : {}),
        odesli,
      }),
    };
    this.defaultMaxTracks = clampTracks(options.maxTracks ?? DEFAULT_MUSIC_LINK_MAX_TRACKS);
  }

  /** Detects a supported link without any network access. */
  parse(query: string): DetectedMusicLink | null {
    return parseMusicLink(query);
  }

  async resolve(query: string, maxTracks?: number): Promise<MusicLinkResolution> {
    const detected = parseMusicLink(query);
    if (!detected) {
      throw new MusicLinkError("PROVIDER_UNAVAILABLE", "That link is not a supported music link.");
    }

    const cap = clampTracks(maxTracks ?? this.defaultMaxTracks);
    const resolved = await this.providers[detected.provider].resolve(detected.url, cap);
    return {
      provider: resolved.provider,
      kind: resolved.kind,
      ...(resolved.title ? { title: resolved.title } : {}),
      // Defensive: a provider must never expand past the configured cap.
      tracks: resolved.tracks.slice(0, cap),
    };
  }
}

export function createMusicLinkResolver(options: MusicLinkResolverOptions = {}): MusicLinkResolver {
  return new MusicLinkResolver(options);
}
