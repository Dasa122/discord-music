import type { ProviderId, ProviderKind } from "./types.js";

export interface DetectedMusicLink {
  provider: ProviderId;
  kind: ProviderKind;
  /** The id of the track/album/playlist the link points at. */
  id: string;
  url: URL;
}

/** Spotify hosts that serve share links. */
const SPOTIFY_DOMAIN = "spotify.com";
/** Apple Music lives on a subdomain so the country prefix can vary. */
const APPLE_DOMAIN = "music.apple.com";

const SPOTIFY_KINDS = new Set<string>(["track", "album", "playlist"]);
const APPLE_LOCALES = /^[a-z]{2}$/i;
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * True for `example.com` and its subdomains, false for `example.com.evil.net`
 * or a look-alike such as `notexample.com`.
 */
function matchesDomain(hostname: string, domain: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * `open.spotify.com/<kind>/<id>`, tolerating a `/intl-xx/` locale prefix that
 * Spotify adds for regional share links.
 */
function spotifyTarget(pathname: string): { kind: ProviderKind; id: string } | null {
  const segments = pathname.split("/").filter(Boolean);
  const first = segments[0];
  if (first !== undefined && /^intl-[a-z]{2,3}(?:-[a-z]{2})?$/i.test(first)) segments.shift();

  const kind = segments[0]?.toLowerCase();
  const id = segments[1];
  if (!kind || !id || !SPOTIFY_KINDS.has(kind) || !ID_PATTERN.test(id)) return null;
  return { kind: kind as ProviderKind, id };
}

/**
 * `music.apple.com/<cc>/album/<slug>/<id>[?i=<trackId>]` is a track when `i`
 * is present and an album otherwise; `/playlist/<slug>/<id>` is a playlist.
 */
function appleTarget(url: URL): { kind: ProviderKind; id: string } | null {
  const segments = url.pathname.split("/").filter(Boolean);
  let index = 0;
  // A two-letter country segment (`/us/`, `/gb/`, …) is optional in share links.
  const first = segments[0];
  if (first !== undefined && APPLE_LOCALES.test(first) && segments.length > 2) index = 1;

  const kind = segments[index]?.toLowerCase();
  const id = segments[index + 2] ?? segments[index + 1];
  if (!kind || !id || !ID_PATTERN.test(id)) return null;

  if (kind === "album") {
    const trackId = url.searchParams.get("i");
    if (trackId !== null && trackId.trim() !== "") {
      return /^[0-9]+$/.test(trackId) ? { kind: "track", id: trackId } : null;
    }
    return { kind: "album", id };
  }
  if (kind === "playlist") return { kind: "playlist", id };
  if (kind === "song") {
    // Some old links use /song/<slug>/<id>; the id is the last segment.
    const songId = segments[index + 2] ?? segments[index + 1];
    return songId && /^[0-9]+$/.test(songId) ? { kind: "track", id: songId } : null;
  }
  return null;
}

/** Detect a supported music link from an already-parsed URL. Pure. */
export function detectMusicLink(url: URL): DetectedMusicLink | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  if (matchesDomain(url.hostname, SPOTIFY_DOMAIN)) {
    const target = spotifyTarget(url.pathname);
    if (!target) return null;
    return { provider: "spotify", ...target, url };
  }

  if (matchesDomain(url.hostname, APPLE_DOMAIN)) {
    const target = appleTarget(url);
    if (!target) return null;
    return { provider: "applemusic", ...target, url };
  }

  return null;
}

/**
 * Detect a supported music link from raw user input. Anything that is not an
 * absolute http(s) URL — including YouTube links and random text — is `null`.
 */
export function parseMusicLink(query: string): DetectedMusicLink | null {
  const trimmed = query.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    return detectMusicLink(new URL(trimmed));
  } catch {
    return null;
  }
}
