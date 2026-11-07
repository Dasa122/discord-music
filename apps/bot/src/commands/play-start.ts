import { logger } from "../logger.js";

export interface ParallelPlayOptions<T> {
  /** Join the voice channel (or the control-side equivalent connection guard). */
  join: () => Promise<void>;
  /** Resolve the query. Both calls start before either is awaited. */
  resolve: () => Promise<T>;
  /**
   * Cleanup run only when the join fails, so a session allocated for the
   * resolve never outlives a failed connection.
   */
  onJoinFailure?: () => Promise<void> | void;
}

export interface ParallelPlayResult<T> {
  resolved: T;
  joinMs: number;
  resolveMs: number;
}

/**
 * Start the voice join and the extractor resolve together. The resolve is
 * started in the same tick as the join, so extraction no longer waits for the
 * voice handshake; a join failure still propagates the connection error.
 */
export async function startPlayInParallel<T>(
  options: ParallelPlayOptions<T>,
): Promise<ParallelPlayResult<T>> {
  const joinStartedAt = Date.now();
  const joinRun = options.join().then(
    () => Date.now() - joinStartedAt,
    async (error: unknown) => {
      try {
        await options.onJoinFailure?.();
      } catch (cleanupError) {
        logger.warn("play_join_cleanup_failed", {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      throw error;
    },
  );

  const resolveStartedAt = Date.now();
  const resolveRun = (async () => {
    const value = await options.resolve();
    return { value, ms: Date.now() - resolveStartedAt };
  })();

  const [joinMs, resolved] = await Promise.all([joinRun, resolveRun]);
  logger.debug("play_parallel", { joinMs, resolveMs: resolved.ms });
  return { resolved: resolved.value, joinMs, resolveMs: resolved.ms };
}
