import {
  type YtdlpOptions,
  resolve as ytdlpResolve,
  resolveSearch as ytdlpResolveSearch,
} from "../ytdlp.js";
import type { TrackResolver } from "./types.js";

export interface YtdlpResolverDeps {
  options?: YtdlpOptions;
  /** Injectable for tests; defaults to the real extractor. */
  resolve?: typeof ytdlpResolve;
  resolveSearch?: typeof ytdlpResolveSearch;
}

/**
 * The pre-P2 path, unchanged: `resolve`/`resolveSearch` spawn yt-dlp. This
 * wrapper exists so the media engine can select a resolver without caring
 * which implementation is behind it.
 */
export function createYtdlpResolver(deps: YtdlpResolverDeps = {}): TrackResolver {
  const resolve = deps.resolve ?? ytdlpResolve;
  const resolveSearch = deps.resolveSearch ?? ytdlpResolveSearch;

  return {
    resolve: (query, _opts) => resolve(query, deps.options),
    resolveSearch: (query, limit) => resolveSearch(query, limit, deps.options),
  };
}
