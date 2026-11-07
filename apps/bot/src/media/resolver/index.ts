import { logger } from "../../logger.js";
import type { ResolvedTrack, YtdlpOptions } from "../ytdlp.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { createInnertubeResolver, type InnertubeClientType } from "./innertube-resolver.js";
import { type ResolveOptions, type TrackResolver, UnsupportedQueryError } from "./types.js";
import { createYtdlpResolver } from "./ytdlp-resolver.js";

export type { InnertubeClientType } from "./innertube-resolver.js";
export type { TrackResolver } from "./types.js";
export { UnsupportedQueryError } from "./types.js";

export type ResolverKind = "ytdlp" | "innertube";

export interface ResolverConfig {
  resolver: ResolverKind;
  innertubeClient: InnertubeClientType;
  /** Consecutive innertube failures before every call goes to yt-dlp. */
  failureThreshold: number;
  /** How long the breaker stays open, in milliseconds. */
  cooldownMs: number;
  /** Used by the yt-dlp path, which stays the fallback even under innertube. */
  ytdlp: YtdlpOptions;
}

export interface ResolverLog {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Test seams: swap the implementations, the clock, and the log sink. */
export interface ResolverOverrides {
  ytdlp?: () => TrackResolver;
  innertube?: () => TrackResolver;
  now?: () => number;
  log?: ResolverLog;
}

/**
 * Innertube with yt-dlp behind a circuit breaker. A resolver failure never
 * fails the command: the call is retried on yt-dlp, and while the circuit is
 * open every call goes straight there.
 */
export class FallbackResolver implements TrackResolver {
  private readonly primary: TrackResolver;
  private readonly fallback: TrackResolver;
  private readonly breaker: CircuitBreaker;
  private readonly cooldownMs: number;
  private readonly log: ResolverLog;
  /** One fallback warning per trip, not one per call. */
  private fallbackLogged = false;

  constructor(
    primary: TrackResolver,
    fallback: TrackResolver,
    breaker: CircuitBreaker,
    options: { cooldownMs: number; log: ResolverLog },
  ) {
    this.primary = primary;
    this.fallback = fallback;
    this.breaker = breaker;
    this.cooldownMs = options.cooldownMs;
    this.log = options.log;
  }

  resolve(query: string, opts?: ResolveOptions): Promise<ResolvedTrack> {
    return this.run((resolver) => resolver.resolve(query, opts), "resolve");
  }

  resolveSearch(query: string, limit: number): Promise<ResolvedTrack[]> {
    return this.run((resolver) => resolver.resolveSearch(query, limit), "search");
  }

  private async run<T>(
    call: (resolver: TrackResolver) => Promise<T>,
    operation: "resolve" | "search",
  ): Promise<T> {
    if (!this.breaker.canAttempt()) {
      return this.delegate(call, `${operation}:circuit_open`);
    }

    try {
      const value = await call(this.primary);
      this.breaker.recordSuccess();
      this.fallbackLogged = false;
      return value;
    } catch (error) {
      if (error instanceof UnsupportedQueryError) {
        // Not an innertube failure: a playlist or a non-YouTube URL. yt-dlp
        // handles it and the breaker must stay closed.
        this.log.debug("resolver_unsupported", { reason: error.message });
        return call(this.fallback);
      }

      const outcome = this.breaker.recordFailure();
      if (outcome.tripped) {
        this.log.warn("resolver_tripped", {
          failures: outcome.failures,
          cooldownMs: this.cooldownMs,
        });
      }
      return this.delegate(call, `${operation}:${outcome.tripped ? "tripped" : "error"}`);
    }
  }

  private async delegate<T>(
    call: (resolver: TrackResolver) => Promise<T>,
    reason: string,
  ): Promise<T> {
    // `fallbackLogged` resets only when the primary succeeds again, so a trip
    // warns once no matter how many calls land on the fallback.
    if (!this.fallbackLogged) {
      this.log.warn("resolver_fallback", { reason });
      this.fallbackLogged = true;
    }
    return call(this.fallback);
  }
}

export function createResolver(
  config: ResolverConfig,
  overrides: ResolverOverrides = {},
): TrackResolver {
  const log = overrides.log ?? logger;
  const ytdlp = overrides.ytdlp?.() ?? createYtdlpResolver({ options: config.ytdlp });

  if (config.resolver === "ytdlp") {
    log.info("resolver_selected", { resolver: "ytdlp" });
    return ytdlp;
  }

  const innertube =
    overrides.innertube?.() ?? createInnertubeResolver({ client: config.innertubeClient });
  const breaker = new CircuitBreaker({
    threshold: config.failureThreshold,
    cooldownMs: config.cooldownMs,
    now: overrides.now,
  });

  log.info("resolver_selected", {
    resolver: "innertube",
    client: config.innertubeClient,
    failureThreshold: config.failureThreshold,
    cooldownMs: config.cooldownMs,
  });

  return new FallbackResolver(innertube, ytdlp, breaker, {
    cooldownMs: config.cooldownMs,
    log,
  });
}
