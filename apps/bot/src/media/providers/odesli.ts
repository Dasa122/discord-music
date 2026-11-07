import { youtubeVideoIdFromUrl } from "../ytdlp.js";
import { type FetchLike, MUSIC_LINK_REQUEST_TIMEOUT_MS, MusicLinkError } from "./types.js";

export const ODESLI_ENDPOINT = "https://api.song.link/v1-alpha.1/links";

export interface OdesliLookup {
  title: string;
  artists: string[];
  thumbnailUrl: string | null;
  /** The YouTube video song.link matched, when it found one. */
  youtubeVideoId: string | null;
}

export interface OdesliClientOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Song.link answers with a comma-separated artist list for collaborations. */
export function splitArtistNames(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/**
 * Map a song.link payload to one track. The source entity (the one the pasted
 * URL points at) supplies the metadata; the YouTube link only supplies the id,
 * so a Spotify track keeps its own title, artists and artwork.
 */
export function parseOdesliPayload(payload: unknown): OdesliLookup {
  const root = asRecord(payload);
  const links = asRecord(root?.linksByPlatform);
  const entities = asRecord(root?.entitiesByUniqueId);

  const youtubeLink = asRecord(links?.youtube) ?? asRecord(links?.youtubeMusic);
  const youtubeUrl = stringValue(youtubeLink?.url);
  const youtubeVideoId = youtubeUrl ? youtubeVideoIdFromUrl(youtubeUrl) : null;

  const sourceEntityId =
    stringValue(root?.entityUniqueId) ??
    stringValue(asRecord(links?.spotify)?.entityUniqueId) ??
    stringValue(asRecord(links?.applemusic)?.entityUniqueId) ??
    stringValue(asRecord(links?.itunes)?.entityUniqueId) ??
    firstNonYoutubeEntityId(entities);

  const entity = sourceEntityId ? asRecord(entities?.[sourceEntityId]) : null;
  const title = stringValue(entity?.title);
  if (!entity || !title) {
    throw new MusicLinkError(
      "PROVIDER_UNAVAILABLE",
      "Songlink returned no track metadata for that link.",
    );
  }

  return {
    title,
    artists: splitArtistNames(stringValue(entity.artistName)),
    thumbnailUrl: stringValue(entity.thumbnailUrl),
    youtubeVideoId,
  };
}

function firstNonYoutubeEntityId(entities: Record<string, unknown> | null): string | null {
  if (!entities) return null;
  for (const [key, value] of Object.entries(entities)) {
    if (key.startsWith("YOUTUBE")) continue;
    const entity = asRecord(value);
    if (entity && stringValue(entity.title)) return key;
  }
  return null;
}

/**
 * Song.link (Odesli) maps a streaming link to every platform that hosts the
 * same recording. No auth, one request, and a YouTube link when it finds one:
 * that is the fast path that skips a YouTube search entirely.
 */
export class OdesliClient {
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: OdesliClientOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? MUSIC_LINK_REQUEST_TIMEOUT_MS;
  }

  async lookup(sourceUrl: string): Promise<OdesliLookup> {
    const endpoint = `${ODESLI_ENDPOINT}?url=${encodeURIComponent(sourceUrl)}`;

    let response: Response;
    try {
      response = await this.fetchFn(endpoint, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new MusicLinkError(
        "PROVIDER_UNAVAILABLE",
        "Songlink could not be reached; try again shortly.",
      );
    }

    if (response.status === 404 || response.status === 400) {
      throw new MusicLinkError(
        "TRACK_NOT_FOUND",
        "Songlink could not find that track on another platform.",
      );
    }
    if (response.status === 429) {
      throw new MusicLinkError(
        "PROVIDER_RATE_LIMITED",
        "Songlink is rate limiting lookups; try again in a minute.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new MusicLinkError(
        "PROVIDER_UNAVAILABLE",
        `Songlink's public lookup is no longer available (HTTP ${response.status}).`,
      );
    }
    if (!response.ok) {
      throw new MusicLinkError(
        "PROVIDER_UNAVAILABLE",
        `Songlink lookup failed (HTTP ${response.status}).`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new MusicLinkError("PROVIDER_UNAVAILABLE", "Songlink returned an unreadable response.");
    }
    return parseOdesliPayload(payload);
  }
}
