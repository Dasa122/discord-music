/**
 * OpenGraph parsing for a Spotify track page, with no network and no DOM.
 *
 * Spotify prerenders metadata for link-preview crawlers; a desktop browser UA
 * gets the generic web-player shell instead (verified against three real
 * tracks: 169 KB with no `og:title` versus 191 KB with full tags), so the
 * provider sends the crawler UA below.
 */

/** Hard stop for the body we are willing to parse; track pages are ~190 KB. */
export const SPOTIFY_PAGE_MAX_BYTES = 512 * 1024;

/** Spotify returns OG tags to link-preview crawlers, not to browser UAs. */
export const SPOTIFY_SCRAPE_USER_AGENT =
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";

/** One step of the resolution order; a slow step fails rather than hangs /play. */
export const SPOTIFY_SCRAPE_TIMEOUT_MS = 5_000;

export type SpotifyPageKind = "track" | "collection";

export interface SpotifyPageMeta {
  /** `null` when the page carried no `og:type`; callers fall back to the URL. */
  kind: SpotifyPageKind | null;
  ogType: string | null;
  title: string;
  artists: string[];
  durationSec: number | null;
  thumbnailUrl: string | null;
  sourceUrl: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntity(entity: string): string | null {
  const lowered = entity.toLowerCase();
  if (lowered.startsWith("#x")) {
    const code = Number.parseInt(lowered.slice(2), 16);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : null;
  }
  if (lowered.startsWith("#")) {
    const code = Number.parseInt(lowered.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : null;
  }
  return NAMED_ENTITIES[lowered] ?? null;
}

/** Decode `&amp;`, `&#39;`, `&quot;` and friends; leave unknown entities alone. */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    return decodeEntity(entity) ?? match;
  });
}

/** Drop `<script>` bodies before parsing: they hold a Next.js blob of JSON. */
export function stripScriptBlocks(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\/>/gi, "");
}

/** Cut the body at a byte boundary so a hostile page cannot exhaust memory. */
export function capHtmlBytes(html: string, maxBytes = SPOTIFY_PAGE_MAX_BYTES): string {
  if (Buffer.byteLength(html, "utf8") <= maxBytes) return html;
  return Buffer.from(html, "utf8").subarray(0, maxBytes).toString("utf8");
}

/** The order the provider applies to every fetched page. */
export function sanitizeSpotifyHtml(html: string, maxBytes = SPOTIFY_PAGE_MAX_BYTES): string {
  return stripScriptBlocks(capHtmlBytes(html, maxBytes));
}

const META_TAG = /<meta\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * `Artist · Album · Song · 2020` → `["Artist"]`. Artists with a comma separate
 * into a list; anything after the first ` · ` segment is album/type/year.
 */
export function parseSpotifyArtists(description: string | null | undefined): string[] {
  const first = cleanText(description).split(/\s*·\s*/)[0] ?? "";
  return first
    .split(",")
    .map((name) => cleanText(name))
    .filter((name) => name !== "");
}

function parseDuration(value: string | null | undefined): number | null {
  const raw = cleanText(value);
  if (raw === "" || !/^\d+$/.test(raw)) return null;
  const seconds = Number.parseInt(raw, 10);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

function absoluteHttpUrl(value: string | null | undefined): string | null {
  const raw = cleanText(value);
  if (raw === "") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Read the Spotify OpenGraph tags out of an already-fetched page. Returns
 * `null` for a page that carries no track metadata at all (a consent wall or
 * the generic web-player shell), which is the caller's signal to try oEmbed.
 */
export function parseSpotifyPage(html: string, fallbackUrl: string): SpotifyPageMeta | null {
  const tags = new Map<string, string>();
  for (const tag of sanitizeSpotifyHtml(html).matchAll(META_TAG)) {
    const attributes = parseAttributes(tag[0]);
    const key = attributes.get("property") ?? attributes.get("name");
    const content = attributes.get("content");
    if (key && content !== undefined && !tags.has(key.toLowerCase())) {
      tags.set(key.toLowerCase(), decodeHtmlEntities(content));
    }
  }

  const ogType = cleanText(tags.get("og:type")) || null;
  const title = cleanText(tags.get("og:title"));
  const description = tags.get("og:description") ?? null;
  const thumbnail = absoluteHttpUrl(tags.get("og:image"));
  const sourceUrl = absoluteHttpUrl(tags.get("og:url")) ?? fallbackUrl;

  if (title === "" && ogType === null) return null;

  const kind: SpotifyPageKind | null =
    ogType === "music.song"
      ? "track"
      : ogType === "music.album" || ogType === "music.playlist"
        ? "collection"
        : null;

  return {
    kind,
    ogType,
    title,
    artists: parseSpotifyArtists(description),
    durationSec: parseDuration(tags.get("music:duration")),
    thumbnailUrl: thumbnail,
    sourceUrl,
  };
}
