/**
 * Bounded-concurrency and rate-limit primitives.
 *
 * Both are deliberately in-memory: this process is the only consumer of its
 * yt-dlp subprocesses, and queue state is already ephemeral.
 */

/**
 * Queued semaphore with a hard wait cap. `acquire()` resolves with an
 * idempotent release function, or rejects with the error produced by
 * `timeoutError` when no slot frees up within `waitMs`.
 */
export class QueuedSemaphore {
  private active = 0;
  private readonly waiters: Array<{
    grant: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(
    private readonly limit: number,
    private readonly waitMs: number,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
    if (!Number.isFinite(waitMs) || waitMs < 1) throw new Error("waitMs must be positive");
  }

  get inUse(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /** Non-blocking variant; returns `null` when every slot is taken. */
  tryAcquire(): (() => void) | null {
    if (this.active >= this.limit) return null;
    this.active += 1;
    return this.releaseOnce();
  }

  async acquire(
    timeoutError: () => Error = () => new Error("semaphore timeout"),
  ): Promise<() => void> {
    const immediate = this.tryAcquire();
    if (immediate) return immediate;

    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        grant: () => {
          clearTimeout(waiter.timer);
          resolve(this.releaseOnce());
        },
        reject: (error: Error) => {
          clearTimeout(waiter.timer);
          reject(error);
        },
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };

      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(timeoutError());
      }, this.waitMs);
      waiter.timer.unref?.();

      this.waiters.push(waiter);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Transfer the slot directly: `active` never drops, so a racing
      // `tryAcquire()` cannot steal it from a queued caller.
      next.grant();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

/**
 * Sliding-window limiter keyed by an opaque string (guild + user).
 *
 * `take()` returns `0` when the call is allowed, otherwise the number of
 * milliseconds until the oldest hit leaves the window.
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
    if (!Number.isFinite(windowMs) || windowMs < 1) throw new Error("windowMs must be positive");
    this.limit = limit;
    this.windowMs = windowMs;
  }

  take(key: string, now = Date.now()): number {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return Math.max(1, this.windowMs - (now - oldest));
    }

    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(now);
    return 0;
  }

  /** Drop keys whose whole window has expired; keeps the map bounded. */
  prune(now = Date.now()): void {
    for (const [key, timestamps] of this.hits) {
      if (timestamps.every((at) => now - at >= this.windowMs)) this.hits.delete(key);
    }
  }

  reset(): void {
    this.hits.clear();
  }

  get size(): number {
    return this.hits.size;
  }
}

/** `/play` and `/search` share one budget per guild member. */
export const COMMAND_RATE_LIMIT = 3;
export const COMMAND_RATE_WINDOW_MS = 30_000;

export const commandRateLimiter = new SlidingWindowRateLimiter(
  COMMAND_RATE_LIMIT,
  COMMAND_RATE_WINDOW_MS,
);

export function commandRateKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

/** `0` = allowed, otherwise seconds to wait (rounded up, minimum 1). */
export function checkCommandRateLimit(guildId: string, userId: string, now = Date.now()): number {
  const waitMs = commandRateLimiter.take(commandRateKey(guildId, userId), now);
  return waitMs === 0 ? 0 : Math.max(1, Math.ceil(waitMs / 1000));
}
