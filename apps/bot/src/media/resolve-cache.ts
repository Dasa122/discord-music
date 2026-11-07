import type { ResolvedTrack } from "./ytdlp.js";

/**
 * Metadata kept for a resolved query. Deliberately excludes `webpageUrl` and
 * every other URL that could be signed or session-scoped: only the canonical
 * video id is stored, and the caller rebuilds the page URL from it.
 */
export interface CachedResolution {
  videoId: string | null;
  title: string;
  durationSec: number | null;
  thumbnailUrl: string | null;
  isPlaylist: boolean;
  entries?: CachedResolution[];
}

export const RESOLVE_CACHE_TTL_MS = 5 * 60_000;
export const RESOLVE_CACHE_MAX_ENTRIES = 200;

/** A scheme at the start of the query means "URL": keep it byte-for-byte. */
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Text queries resolve the same regardless of case or spacing, so normalise
 * them to one cache key. URLs are never rewritten — a different URL is a
 * different track.
 */
export function normalizeResolveKey(query: string): string {
  const trimmed = query.trim();
  if (URL_PATTERN.test(trimmed)) return trimmed;
  return trimmed.toLowerCase().replace(/\s+/g, " ");
}

/**
 * Stream URLs are signed and expire within hours, so they must never reach the
 * cache. `webpageUrl` is not stored at all; this guard covers the other fields
 * in case an extractor ever puts a media URL in one of them.
 */
function isStreamUrl(value: string): boolean {
  return /googlevideo\.com/i.test(value);
}

function sanitizeMetadata(track: ResolvedTrack): CachedResolution {
  const entries = track.entries?.map(sanitizeMetadata);
  const cached: CachedResolution = {
    videoId: track.videoId,
    title: track.title,
    durationSec: track.durationSec,
    thumbnailUrl:
      track.thumbnailUrl && !isStreamUrl(track.thumbnailUrl) ? track.thumbnailUrl : null,
    isPlaylist: track.isPlaylist,
  };
  if (entries) cached.entries = entries;
  return cached;
}

interface CacheEntry {
  value: CachedResolution;
  storedAt: number;
}

/**
 * Small LRU of resolved query metadata. One entry per normalised query, a five
 * minute TTL and a hard 200-entry cap; the oldest entry is evicted first.
 */
export class ResolveCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();
  private hits = 0;
  private lastHit = false;

  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? RESOLVE_CACHE_TTL_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? RESOLVE_CACHE_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
  }

  get(query: string): CachedResolution | null {
    const key = normalizeResolveKey(query);
    const entry = this.entries.get(key);
    if (!entry) {
      this.lastHit = false;
      return null;
    }

    if (this.now() - entry.storedAt >= this.ttlMs) {
      this.entries.delete(key);
      this.lastHit = false;
      return null;
    }

    // Re-insert so the Map's iteration order tracks recency (LRU).
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    this.lastHit = true;
    return entry.value;
  }

  set(query: string, value: ResolvedTrack): void {
    const key = normalizeResolveKey(query);
    this.entries.delete(key);
    this.entries.set(key, { value: sanitizeMetadata(value), storedAt: this.now() });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** `hit` is the outcome of the most recent `get()`; `hits` is cumulative. */
  stats(): { hit: boolean; hits: number; size: number } {
    return { hit: this.lastHit, hits: this.hits, size: this.entries.size };
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.lastHit = false;
  }
}
