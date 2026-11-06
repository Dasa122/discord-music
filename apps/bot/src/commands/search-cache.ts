import type { ResolvedTrack } from "../media/ytdlp.js";

interface CachedSearch {
  results: ResolvedTrack[];
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CachedSearch>();

export function setSearchResults(messageId: string, results: ResolvedTrack[]): void {
  const now = Date.now();
  for (const [key, value] of cache) {
    if (value.expiresAt <= now) cache.delete(key);
  }
  if (cache.size > 100) cache.clear();
  cache.set(messageId, { results, expiresAt: now + TTL_MS });
}

export function getSearchResults(messageId: string): ResolvedTrack[] | null {
  const cached = cache.get(messageId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    cache.delete(messageId);
    return null;
  }
  return cached.results;
}
