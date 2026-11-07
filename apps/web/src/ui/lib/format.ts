const numberFormatter = new Intl.NumberFormat("en-US");

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Formats a duration in seconds as `m:ss` or `h:mm:ss`.
 * Returns an em dash for missing, negative, or non-finite values.
 */
export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) {
    return "—";
  }

  const totalSeconds = Math.floor(sec);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
  }

  return `${minutes}:${paddedSeconds}`;
}

/**
 * Formats an ISO timestamp as a short relative label. `now` is injectable for
 * deterministic tests and can be a timestamp or a Date.
 */
export function formatRelativeTime(iso: string, now: number | Date = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return "—";
  }

  const nowMs = now instanceof Date ? now.getTime() : now;
  const diff = nowMs - then;
  if (diff < MINUTE_MS) {
    return "just now";
  }

  const minutes = Math.floor(diff / MINUTE_MS);
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }

  const hours = Math.floor(diff / HOUR_MS);
  if (hours < 24) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }

  const days = Math.floor(diff / DAY_MS);
  if (days === 1) {
    return "yesterday";
  }
  if (days < 30) {
    return `${days} days ago`;
  }

  const months = Math.floor(days / 30);
  if (months < 12) {
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }

  const years = Math.floor(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

/** Groups thousands using the en-US locale, independent of the host locale. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return numberFormatter.format(value);
}

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

/** Formats a byte count with 1000-based units and one decimal above 1 KB. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes < 1000) {
    return `${Math.round(bytes)} B`;
  }

  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), BYTE_UNITS.length - 1);
  return `${(bytes / 1000 ** exponent).toFixed(1)} ${BYTE_UNITS[exponent]}`;
}

/** Formats a 0–100 percentage as a whole-number label. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return `${Math.round(value)}%`;
}

/** Formats an elapsed millisecond span compactly (`500 ms`, `1.5s`, `2m 05s`). */
export function formatDurationMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    return "—";
  }

  const ms = Math.round(value);
  if (ms < 1000) {
    return `${ms} ms`;
  }

  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * Authentik subjects are not Discord identities, so they are never shown.
 * Admins see themselves as "You" and every other admin generically.
 */
export function formatActorLabel(actorSub: string, viewerSub: string | null | undefined): string {
  return viewerSub !== null && viewerSub !== undefined && actorSub === viewerSub
    ? "You"
    : "Another admin";
}

/** Constrains `value` to the inclusive `[min, max]` range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
