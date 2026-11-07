import { logger } from "../../logger.js";
import { type DetectedMusicLink, detectMusicLink } from "./detect.js";
import type { OdesliClient, OdesliLookup } from "./odesli.js";
import {
  capHtmlBytes,
  parseSpotifyPage,
  SPOTIFY_PAGE_MAX_BYTES,
  SPOTIFY_SCRAPE_TIMEOUT_MS,
  SPOTIFY_SCRAPE_USER_AGENT,
  type SpotifyPageMeta,
} from "./spotify-meta.js";
import {
  type FetchLike,
  MUSIC_LINK_REQUEST_TIMEOUT_MS,
  MusicLinkError,
  type MusicLinkProvider,
  type ProviderResolution,
  type ProviderTrack,
} from "./types.js";

const ACCOUNTS_URL = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com";
const OEMBED_URL = "https://open.spotify.com/oembed";
/** One Spotify page; the album and playlist endpoints both cap at 50 in practice. */
const PAGE_SIZE = 50;

export const MISSING_CREDENTIALS_MESSAGE =
  "Spotify albums and playlists need Web API credentials (a Premium Spotify account), which this bot is not configured with. Link a single track instead, or use the YouTube or Apple Music equivalent.";

export const SPOTIFY_UNREADABLE_MESSAGE = "Could not read that Spotify link.";

interface OembedTrack {
  title: string;
  thumbnailUrl: string | null;
}

export interface SpotifyProviderOptions {
  clientId?: string;
  clientSecret?: string;
  fetch?: FetchLike;
  /** Injectable clock; token expiry is cached against it. */
  now?: () => number;
  odesli: OdesliClient;
  timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Spotify returns images largest-first but does not promise it. */
function largestImageUrl(images: unknown): string | null {
  let best: string | null = null;
  let bestWidth = -1;
  for (const entry of asArray(images)) {
    const image = asRecord(entry);
    const url = stringValue(image?.url);
    if (!url) continue;
    const width = numberValue(image?.width) ?? 0;
    if (width > bestWidth) {
      best = url;
      bestWidth = width;
    }
  }
  return best;
}

/** One Spotify track object (full or simplified) → a source track. */
export function mapSpotifyTrack(
  raw: unknown,
  sourceUrl: string,
  fallbackThumbnail: string | null = null,
): ProviderTrack | null {
  const track = asRecord(raw);
  const title = stringValue(track?.name);
  if (!track || !title) return null;

  const artists = asArray(track.artists)
    .map((entry) => stringValue(asRecord(entry)?.name))
    .filter((name): name is string => name !== null);
  const durationMs = numberValue(track.duration_ms);
  const thumbnail = largestImageUrl(asRecord(track.album)?.images) ?? fallbackThumbnail;
  const id = stringValue(track.id);

  return {
    title,
    artists,
    durationSec: durationMs === null ? null : Math.round(durationMs / 1000),
    thumbnailUrl: thumbnail,
    sourceUrl: id ? `https://open.spotify.com/track/${id}` : sourceUrl,
    provider: "spotify",
  };
}

function mapOdesliTrack(odesli: OdesliLookup, sourceUrl: string): ProviderTrack {
  return {
    title: odesli.title,
    artists: odesli.artists,
    durationSec: null,
    thumbnailUrl: odesli.thumbnailUrl,
    sourceUrl,
    provider: "spotify",
    ...(odesli.youtubeVideoId ? { youtubeVideoId: odesli.youtubeVideoId } : {}),
  };
}

/**
 * Spotify's Web API, behind a client-credentials token reused until it expires.
 * Without credentials a track still resolves through song.link; a collection
 * cannot (song.link has no collection lookups) so it fails with a message that
 * names exactly which variables to set.
 */
export function createSpotifyProvider(options: SpotifyProviderOptions): MusicLinkProvider {
  const fetchFn: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? MUSIC_LINK_REQUEST_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const hasCredentials = Boolean(options.clientId && options.clientSecret);

  let token: { value: string; expiresAt: number } | null = null;

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new MusicLinkError("PROVIDER_UNAVAILABLE", "Spotify could not be reached.", "spotify");
    }
  }

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > now()) return token.value;
    if (!options.clientId || !options.clientSecret) {
      throw new MusicLinkError("PROVIDER_AUTH_REQUIRED", MISSING_CREDENTIALS_MESSAGE, "spotify");
    }

    const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64");
    const response = await request(ACCOUNTS_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new MusicLinkError(
        "PROVIDER_AUTH_REQUIRED",
        "Spotify rejected SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET.",
        "spotify",
      );
    }
    if (response.status === 429) {
      throw new MusicLinkError(
        "PROVIDER_RATE_LIMITED",
        "Spotify is rate limiting lookups; try again in a minute.",
        "spotify",
      );
    }
    if (!response.ok) {
      throw new MusicLinkError(
        "PROVIDER_UNAVAILABLE",
        `Spotify authentication failed (HTTP ${response.status}).`,
        "spotify",
      );
    }

    const payload = asRecord(await response.json());
    const value = stringValue(payload?.access_token);
    if (!value) {
      throw new MusicLinkError(
        "PROVIDER_UNAVAILABLE",
        "Spotify returned an unusable access token.",
        "spotify",
      );
    }
    const expiresInSec = numberValue(payload?.expires_in) ?? 3_600;
    // Renew a minute early so a token cannot expire mid-lookup.
    token = { value, expiresAt: now() + Math.max(0, expiresInSec * 1_000 - 60_000) };
    return value;
  }

  async function apiGet(path: string): Promise<unknown> {
    const response = await request(`${API_BASE}${path}`, {
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    if (response.status === 404) {
      throw new MusicLinkError("TRACK_NOT_FOUND", "Spotify could not find that track.", "spotify");
    }
    if (response.status === 429) {
      throw new MusicLinkError(
        "PROVIDER_RATE_LIMITED",
        "Spotify is rate limiting lookups; try again in a minute.",
        "spotify",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new MusicLinkError(
        "PROVIDER_AUTH_REQUIRED",
        "Spotify rejected SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET.",
        "spotify",
      );
    }
    if (!response.ok) {
      throw new MusicLinkError(
        "PROVIDER_UNAVAILABLE",
        `Spotify lookup failed (HTTP ${response.status}).`,
        "spotify",
      );
    }
    return await response.json();
  }

  /** song.link first: a YouTube link there saves both the API call and a search. */
  async function lookupOdesli(
    url: URL,
  ): Promise<{ track: OdesliLookup | null; error: MusicLinkError | null }> {
    try {
      return { track: await options.odesli.lookup(url.toString()), error: null };
    } catch (error) {
      return {
        track: null,
        error:
          error instanceof MusicLinkError
            ? error
            : new MusicLinkError("PROVIDER_UNAVAILABLE", "Songlink lookup failed.", "spotify"),
      };
    }
  }

  /** Cap the body before `text()` so a hostile response cannot balloon memory. */
  async function readCappedBody(response: Response): Promise<string> {
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      const capped =
        bytes.length > SPOTIFY_PAGE_MAX_BYTES ? bytes.subarray(0, SPOTIFY_PAGE_MAX_BYTES) : bytes;
      return new TextDecoder().decode(capped);
    } catch {
      return capHtmlBytes(await response.text());
    }
  }

  function scrapeHeaders(accept: string): Record<string, string> {
    // A desktop UA gets Spotify's generic web-player shell with no OG tags;
    // link-preview crawlers get the prerendered tags (verified on real tracks).
    return {
      "user-agent": SPOTIFY_SCRAPE_USER_AGENT,
      "accept-language": "en",
      accept,
    };
  }

  /** Step 2: OpenGraph tags from the track page. Never throws. */
  async function scrapeTrackPage(url: URL): Promise<SpotifyPageMeta | null> {
    const startedAt = Date.now();
    let meta: SpotifyPageMeta | null = null;
    try {
      const response = await fetchFn(url.toString(), {
        headers: scrapeHeaders("text/html,application/xhtml+xml"),
        signal: AbortSignal.timeout(SPOTIFY_SCRAPE_TIMEOUT_MS),
      });
      if (response.ok) {
        meta = parseSpotifyPage(await readCappedBody(response), url.toString());
      }
    } catch {
      // A timeout or network error is this step's failure, not the command's.
    }
    const ms = Date.now() - startedAt;
    logger.debug("spotify_scrape", { ok: meta !== null, source: "meta", ms });
    return meta;
  }

  /** Step 3: oEmbed gives a title and artwork, but never an artist. */
  async function lookupOembed(url: URL): Promise<OembedTrack | null> {
    const startedAt = Date.now();
    let track: OembedTrack | null = null;
    try {
      const response = await fetchFn(`${OEMBED_URL}?url=${encodeURIComponent(url.toString())}`, {
        headers: scrapeHeaders("application/json"),
        signal: AbortSignal.timeout(SPOTIFY_SCRAPE_TIMEOUT_MS),
      });
      if (response.ok) {
        const payload = asRecord(await response.json());
        const title = stringValue(payload?.title)?.trim() ?? "";
        if (title !== "") {
          track = { title, thumbnailUrl: stringValue(payload?.thumbnail_url) };
        }
      }
    } catch {
      // Same rule as the scrape: this step failed, try the next one.
    }
    const ms = Date.now() - startedAt;
    logger.debug("spotify_scrape", { ok: track !== null, source: "oembed", ms });
    return track;
  }

  function mapScrapedTrack(meta: SpotifyPageMeta, fallbackUrl: string): ProviderTrack {
    return {
      title: meta.title,
      artists: meta.artists,
      durationSec: meta.durationSec,
      thumbnailUrl: meta.thumbnailUrl,
      sourceUrl: meta.sourceUrl || fallbackUrl,
      provider: "spotify",
    };
  }

  function collectionAuthError(): MusicLinkError {
    return new MusicLinkError("PROVIDER_AUTH_REQUIRED", MISSING_CREDENTIALS_MESSAGE, "spotify");
  }

  /**
   * No credentials: the page's OpenGraph tags, then oEmbed, then a typed
   * failure. A page that reports a collection cannot be expanded without the
   * Web API, so it fails honestly instead of resolving the wrong track.
   */
  async function resolveTrackWithoutCredentials(target: DetectedMusicLink): Promise<ProviderTrack> {
    const meta = await scrapeTrackPage(target.url);
    if (meta?.kind === "collection") throw collectionAuthError();
    if (meta && meta.title !== "") return mapScrapedTrack(meta, target.url.toString());

    const oembed = await lookupOembed(target.url);
    if (oembed) {
      return {
        title: oembed.title,
        // oEmbed has no artist: the engine searches with the title alone.
        artists: [],
        durationSec: null,
        thumbnailUrl: oembed.thumbnailUrl,
        sourceUrl: target.url.toString(),
        provider: "spotify",
      };
    }

    throw new MusicLinkError("PROVIDER_UNAVAILABLE", SPOTIFY_UNREADABLE_MESSAGE, "spotify");
  }

  async function resolveTrack(target: DetectedMusicLink): Promise<ProviderTrack> {
    if (!hasCredentials) return await resolveTrackWithoutCredentials(target);

    const { track } = await lookupOdesli(target.url);
    if (track?.youtubeVideoId) return mapOdesliTrack(track, target.url.toString());

    const mapped = mapSpotifyTrack(await apiGet(`/v1/tracks/${target.id}`), target.url.toString());
    if (!mapped) {
      throw new MusicLinkError("TRACK_NOT_FOUND", "Spotify returned no track metadata.");
    }
    return mapped;
  }

  async function resolveAlbum(
    target: DetectedMusicLink,
    cap: number,
  ): Promise<{ title: string | undefined; tracks: ProviderTrack[] }> {
    const album = asRecord(await apiGet(`/v1/albums/${target.id}`));
    const fallbackThumbnail = largestImageUrl(album?.images);
    const tracks: ProviderTrack[] = [];

    const collect = (items: unknown): void => {
      for (const item of asArray(items)) {
        if (tracks.length >= cap) return;
        const mapped = mapSpotifyTrack(item, target.url.toString(), fallbackThumbnail);
        if (mapped) tracks.push(mapped);
      }
    };

    const albumTracks = asRecord(album?.tracks);
    collect(albumTracks?.items);

    const total = numberValue(albumTracks?.total) ?? tracks.length;
    let offset = asArray(albumTracks?.items).length;
    while (tracks.length < cap && offset < total) {
      const page = asRecord(
        await apiGet(`/v1/albums/${target.id}/tracks?limit=${PAGE_SIZE}&offset=${offset}`),
      );
      const items = asArray(page?.items);
      if (items.length === 0) break;
      collect(items);
      offset += items.length;
    }
    return { title: stringValue(album?.name) ?? undefined, tracks };
  }

  async function resolvePlaylist(
    target: DetectedMusicLink,
    cap: number,
  ): Promise<{ title: string | undefined; tracks: ProviderTrack[] }> {
    const meta = asRecord(await apiGet(`/v1/playlists/${target.id}?fields=name`));
    const tracks: ProviderTrack[] = [];
    let offset = 0;
    while (tracks.length < cap) {
      const page = asRecord(
        await apiGet(`/v1/playlists/${target.id}/tracks?limit=${PAGE_SIZE}&offset=${offset}`),
      );
      const items = asArray(page?.items);
      if (items.length === 0) break;
      for (const item of items) {
        if (tracks.length >= cap) break;
        // Unavailable playlist entries are `{ track: null }`.
        const mapped = mapSpotifyTrack(asRecord(item)?.track, target.url.toString());
        if (mapped) tracks.push(mapped);
      }
      offset += items.length;
      if (items.length < PAGE_SIZE) break;
    }
    return { title: stringValue(meta?.name) ?? undefined, tracks };
  }

  return {
    id: "spotify",
    matches: (url) => detectMusicLink(url)?.provider === "spotify",
    async resolve(url: URL, maxTracks = 50): Promise<ProviderResolution> {
      const target = detectMusicLink(url);
      if (target?.provider !== "spotify") {
        throw new MusicLinkError("PROVIDER_UNAVAILABLE", "That is not a Spotify link.", "spotify");
      }

      if (target.kind === "track") {
        return { provider: "spotify", kind: "track", tracks: [await resolveTrack(target)] };
      }
      if (!hasCredentials) {
        throw new MusicLinkError("PROVIDER_AUTH_REQUIRED", MISSING_CREDENTIALS_MESSAGE, "spotify");
      }

      const cap = Math.max(1, maxTracks);
      const collection =
        target.kind === "album"
          ? await resolveAlbum(target, cap)
          : await resolvePlaylist(target, cap);
      return {
        provider: "spotify",
        kind: target.kind,
        ...(collection.title ? { title: collection.title } : {}),
        tracks: collection.tracks,
      };
    },
  };
}
