import { type DetectedMusicLink, detectMusicLink } from "./detect.js";
import type { OdesliClient, OdesliLookup } from "./odesli.js";
import {
  type FetchLike,
  MUSIC_LINK_REQUEST_TIMEOUT_MS,
  MusicLinkError,
  type MusicLinkProvider,
  type ProviderResolution,
  type ProviderTrack,
} from "./types.js";

export const APPLE_MUSIC_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export interface AppleMusicProviderOptions {
  fetch?: FetchLike;
  odesli: OdesliClient;
  userAgent?: string;
  timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** ISO-8601 duration (`PT3M42S`, `PT1H2M3S`) → whole seconds. */
export function parseIsoDuration(value: string | null): number | null {
  if (!value) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
    value.trim(),
  );
  if (!match) return null;
  const days = Number.parseInt(match[1] ?? "0", 10);
  const hours = Number.parseInt(match[2] ?? "0", 10);
  const minutes = Number.parseInt(match[3] ?? "0", 10);
  const seconds = Number.parseFloat(match[4] ?? "0");
  if (![days, hours, minutes, seconds].every((part) => Number.isFinite(part))) return null;
  return Math.round(days * 86_400 + hours * 3_600 + minutes * 60 + seconds);
}

/** Apple image templates carry `{w}`/`{h}` placeholders; 512 is a safe square. */
function imageUrl(value: unknown): string | null {
  if (typeof value === "string") return value.replace(/\{w\}/g, "512").replace(/\{h\}/g, "512");
  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = imageUrl(entry);
      if (url) return url;
    }
    return null;
  }
  const record = asRecord(value);
  return record ? imageUrl(record.url) : null;
}

function artistNames(value: unknown): string[] {
  if (typeof value === "string") {
    const name = value.trim();
    return name === "" ? [] : [name];
  }
  if (Array.isArray(value)) {
    const names: string[] = [];
    for (const entry of value) names.push(...artistNames(entry));
    return names;
  }
  const record = asRecord(value);
  const name = record ? stringValue(record.name) : null;
  return name ? [name] : [];
}

/** Parse every readable `<script type="application/ld+json">` block on a page. */
export function extractJsonLdScripts(html: string): unknown[] {
  const scripts: unknown[] = [];
  const pattern =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const body = match[1]?.trim();
    if (!body) continue;
    try {
      scripts.push(JSON.parse(body));
    } catch {
      // A broken block must not hide the other blocks on the page.
    }
  }
  return scripts;
}

function collectNodes(value: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectNodes(entry, out);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  if (record["@type"] !== undefined) out.push(record);
  for (const nested of Object.values(record)) {
    if (typeof nested === "object" && nested !== null) collectNodes(nested, out);
  }
}

function typesOf(node: Record<string, unknown>): string[] {
  const value = node["@type"];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function findNodes(scripts: unknown[], wanted: ReadonlySet<string>): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  for (const script of scripts) collectNodes(script, nodes);
  return nodes.filter((node) => typesOf(node).some((type) => wanted.has(type)));
}

function trackList(entity: Record<string, unknown>): unknown[] {
  const value = entity.track ?? entity.tracks;
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

/** Map one schema.org `MusicRecording`/`MusicComposition` to a source track. */
export function mapAppleTrack(
  raw: unknown,
  sourceUrl: string,
  fallbackThumbnail: string | null = null,
  fallbackArtists: string[] = [],
): ProviderTrack | null {
  const track = asRecord(raw);
  const title = stringValue(track?.name);
  if (!track || !title) return null;

  // A track page wraps the recording in `audio`; an album page lists recordings
  // directly. Both expose artists on the recording, and albums also on the album.
  const audio = asRecord(track.audio);
  const artists = artistNames(track.byArtist ?? audio?.byArtist ?? track.artist);
  const duration =
    stringValue(track.duration) ?? stringValue(track.timeRequired) ?? stringValue(audio?.duration);

  return {
    title,
    artists: artists.length > 0 ? artists : fallbackArtists,
    durationSec: parseIsoDuration(duration),
    thumbnailUrl:
      imageUrl(track.image) ??
      imageUrl(audio?.thumbnailUrl) ??
      imageUrl(asRecord(track.inAlbum)?.image) ??
      fallbackThumbnail,
    sourceUrl:
      stringValue(track.url) ?? stringValue(audio?.url) ?? stringValue(track["@id"]) ?? sourceUrl,
    provider: "applemusic",
  };
}

function mapOdesliTrack(odesli: OdesliLookup, sourceUrl: string): ProviderTrack {
  return {
    title: odesli.title,
    artists: odesli.artists,
    durationSec: null,
    thumbnailUrl: odesli.thumbnailUrl,
    sourceUrl,
    provider: "applemusic",
    ...(odesli.youtubeVideoId ? { youtubeVideoId: odesli.youtubeVideoId } : {}),
  };
}

/**
 * Apple Music pages publish schema.org JSON-LD, so one normal page GET yields
 * an album/playlist and all of its tracks without any private API. song.link
 * still goes first for a single track because it can supply a YouTube id.
 */
export function createAppleMusicProvider(options: AppleMusicProviderOptions): MusicLinkProvider {
  const fetchFn: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? MUSIC_LINK_REQUEST_TIMEOUT_MS;
  const userAgent = options.userAgent ?? APPLE_MUSIC_USER_AGENT;

  async function fetchPage(url: URL): Promise<string> {
    let response: Response;
    try {
      response = await fetchFn(url.toString(), {
        headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new MusicLinkError(
        "PROVIDER_UNAVAILABLE",
        "Apple Music could not be reached; try again shortly.",
        "applemusic",
      );
    }
    if (response.status === 404) {
      throw new MusicLinkError(
        "TRACK_NOT_FOUND",
        "Apple Music could not find that link.",
        "applemusic",
      );
    }
    if (response.status === 429) {
      throw new MusicLinkError(
        "PROVIDER_RATE_LIMITED",
        "Apple Music is rate limiting lookups; try again in a minute.",
        "applemusic",
      );
    }
    if (!response.ok) {
      throw new MusicLinkError(
        "PROVIDER_UNAVAILABLE",
        `Apple Music lookup failed (HTTP ${response.status}).`,
        "applemusic",
      );
    }
    return await response.text();
  }

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
            : new MusicLinkError("PROVIDER_UNAVAILABLE", "Songlink lookup failed.", "applemusic"),
      };
    }
  }

  async function resolveTrack(target: DetectedMusicLink): Promise<ProviderTrack> {
    const { track: odesliTrack, error } = await lookupOdesli(target.url);
    if (odesliTrack?.youtubeVideoId) return mapOdesliTrack(odesliTrack, target.url.toString());

    const scripts = extractJsonLdScripts(await fetchPage(target.url));
    const recordings = findNodes(scripts, new Set(["MusicRecording", "MusicComposition"]));
    const exact = recordings.find((node) => {
      const url = stringValue(node.url) ?? stringValue(node["@id"]);
      return url?.includes(target.id) ?? false;
    });
    const album = asRecord(findNodes(scripts, new Set(["MusicAlbum"]))[0]);
    const mapped = mapAppleTrack(
      exact ?? recordings[0],
      target.url.toString(),
      imageUrl(album?.image),
      artistNames(album?.byArtist),
    );
    if (mapped) return mapped;

    if (odesliTrack) return mapOdesliTrack(odesliTrack, target.url.toString());
    if (error) throw error;
    throw new MusicLinkError(
      "PROVIDER_UNAVAILABLE",
      "Apple Music did not expose track metadata for that link.",
      "applemusic",
    );
  }

  async function resolveCollection(
    target: DetectedMusicLink,
    maxTracks: number,
  ): Promise<{ title: string | undefined; tracks: ProviderTrack[] }> {
    const html = await fetchPage(target.url);
    const scripts = extractJsonLdScripts(html);
    const wanted =
      target.kind === "playlist" ? new Set(["MusicPlaylist"]) : new Set(["MusicAlbum"]);
    const entity = findNodes(scripts, wanted)[0];
    if (!entity) {
      throw new MusicLinkError(
        "PROVIDER_UNAVAILABLE",
        `Apple Music did not expose ${target.kind} metadata for that link.`,
        "applemusic",
      );
    }

    const fallbackThumbnail = imageUrl(entity.image);
    const fallbackArtists = artistNames(entity.byArtist);
    const tracks: ProviderTrack[] = [];
    for (const raw of trackList(entity)) {
      if (tracks.length >= maxTracks) break;
      const mapped = mapAppleTrack(raw, target.url.toString(), fallbackThumbnail, fallbackArtists);
      if (mapped) tracks.push(mapped);
    }
    if (tracks.length === 0) {
      throw new MusicLinkError(
        "PROVIDER_UNAVAILABLE",
        `Apple Music listed no playable tracks in that ${target.kind}.`,
        "applemusic",
      );
    }
    return { title: stringValue(entity.name) ?? undefined, tracks };
  }

  return {
    id: "applemusic",
    matches: (url) => detectMusicLink(url)?.provider === "applemusic",
    async resolve(url: URL, maxTracks = 50): Promise<ProviderResolution> {
      const target = detectMusicLink(url);
      if (target?.provider !== "applemusic") {
        throw new MusicLinkError(
          "PROVIDER_UNAVAILABLE",
          "That is not an Apple Music link.",
          "applemusic",
        );
      }

      if (target.kind === "track") {
        return { provider: "applemusic", kind: "track", tracks: [await resolveTrack(target)] };
      }
      const collection = await resolveCollection(target, Math.max(1, maxTracks));
      return {
        provider: "applemusic",
        kind: target.kind,
        ...(collection.title ? { title: collection.title } : {}),
        tracks: collection.tracks,
      };
    },
  };
}
