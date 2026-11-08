/**
 * A stream that ends long before its known duration is truncated, not finished.
 * The AudioPlayer reports both cases as `Idle`, so this module draws the line
 * and plans the recovery; `GuildPlayer` only executes the plan.
 */

/** A track that ends before 90% of its duration was cut short. */
export const DEFAULT_TRUNCATION_RATIO = 0.9;
/** Two resumes per track, then the queue moves on (no infinite recovery loop). */
export const MAX_TRUNCATION_RECOVERIES = 2;

export interface TruncationCheck {
  positionSec: number;
  durationSec: number | null | undefined;
  /** Live streams have no duration and legitimately end whenever they end. */
  isLive?: boolean;
  ratio?: number;
}

/**
 * Was this track cut short? A live or duration-less track can never be called
 * truncated, and a track that reached `ratio` of its duration ended normally.
 */
export function isStreamTruncated(input: TruncationCheck): boolean {
  const { positionSec, durationSec, isLive = false } = input;
  const ratio = input.ratio ?? DEFAULT_TRUNCATION_RATIO;

  if (isLive) return false;
  if (durationSec === null || durationSec === undefined) return false;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return false;
  if (!Number.isFinite(positionSec)) return false;

  // The boundary (exactly 90%) is "finished", not truncated. Rounding the
  // threshold keeps `duration * 0.9` from drifting one ulp above the position.
  const threshold = Math.round(durationSec * ratio * 1_000_000) / 1_000_000;
  return positionSec < threshold;
}

export type TruncationRecoveryAction = "resume-cache" | "retry-url" | "resume-ytdlp" | "advance";

export interface TruncationRecoveryInput {
  positionSec: number;
  durationSec: number | null | undefined;
  /** The session cache already holds the complete file. */
  hasCache: boolean;
  /** The resolver can mint a fresh stream URL for this track. */
  hasUrl: boolean;
  /** Recoveries already attempted for this track (0, 1, 2…). */
  recoveries: number;
  maxRecoveries?: number;
}

export interface TruncationRecoveryPlan {
  action: TruncationRecoveryAction;
  /** Where playback should resume, in seconds (0 when advancing). */
  startSec: number;
}

/**
 * Recovery order: the complete cache (no gap), then one fresh URL at the
 * resume offset (no gap), then the yt-dlp pipe (short gap), then the next
 * track. Two recoveries are allowed before giving up.
 */
export function planTruncationRecovery(input: TruncationRecoveryInput): TruncationRecoveryPlan {
  const { durationSec } = input;
  if (durationSec === null || durationSec === undefined) {
    return { action: "advance", startSec: 0 };
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { action: "advance", startSec: 0 };
  }
  if (!Number.isFinite(input.positionSec)) return { action: "advance", startSec: 0 };

  const startSec = Math.min(Math.max(0, Math.floor(input.positionSec)), Math.floor(durationSec));
  // Resuming at (or past) the end would produce no audio and Idle again.
  if (startSec >= durationSec) return { action: "advance", startSec: 0 };

  const maxRecoveries = input.maxRecoveries ?? MAX_TRUNCATION_RECOVERIES;
  if (input.recoveries >= maxRecoveries) return { action: "advance", startSec: 0 };

  if (input.hasCache) return { action: "resume-cache", startSec };
  if (input.hasUrl) return { action: "retry-url", startSec };
  return { action: "resume-ytdlp", startSec };
}
