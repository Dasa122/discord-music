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

/** Constrains `value` to the inclusive `[min, max]` range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
