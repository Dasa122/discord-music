export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) {
    return "Live / unknown";
  }

  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function capitalize(text: string): string {
  if (text.length === 0) return text;
  return `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}

const MARKDOWN_SPECIALS = /[\\*_~|`>[\]]/g;

/**
 * Neutralise Discord markdown in untrusted text (yt-dlp titles, search
 * queries, display names). Escaping `[`/`]` is what stops `[text](url)` from
 * rendering as a masked link; the rest keeps formatting from bleeding out.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIALS, (character) => `\\${character}`);
}
