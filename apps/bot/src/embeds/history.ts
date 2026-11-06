import { EmbedBuilder } from "discord.js";
import { COLORS } from "./colors.js";
import { escapeMarkdown, formatDuration, truncate } from "./format.js";

export interface HistoryItemView {
  title: string;
  url: string;
  requestedBy: string;
  playedAt: Date | string;
  durationSec?: number | null;
}

export const HISTORY_PAGE_SIZE = 10;
export const MAX_HISTORY_PAGE = 1000;

/** A page option is user input; clamp it so the offset stays sane. */
export function clampHistoryPage(page: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.trunc(page)), MAX_HISTORY_PAGE);
}

export function historyPageCount(total: number, pageSize = HISTORY_PAGE_SIZE): number {
  const size = Math.max(1, Math.trunc(pageSize));
  return Math.max(1, Math.ceil(Math.max(0, total) / size));
}

export function buildHistoryEmbed(
  items: HistoryItemView[],
  page: number,
  total: number,
  pageSize = HISTORY_PAGE_SIZE,
): EmbedBuilder {
  const totalPages = historyPageCount(total, pageSize);
  const currentPage = Math.min(Math.max(1, Math.trunc(page)), totalPages);
  const start = (currentPage - 1) * pageSize;

  const lines = items.map((item, index) => {
    const playedAt = new Date(item.playedAt);
    const timestamp = Number.isNaN(playedAt.getTime())
      ? "unknown time"
      : `<t:${Math.floor(playedAt.getTime() / 1000)}:R>`;
    const duration = item.durationSec ? ` · \`${formatDuration(item.durationSec)}\`` : "";
    return `**${start + index + 1}.** [${truncate(escapeMarkdown(item.title), 80)}](${item.url}) · \`${truncate(
      escapeMarkdown(item.requestedBy),
      40,
    )}\` · ${timestamp}${duration}`;
  });

  return new EmbedBuilder()
    .setColor(COLORS.idle)
    .setTitle("Play history")
    .setDescription(
      truncate(
        [
          `**Page ${currentPage}/${totalPages} · ${total} play${total === 1 ? "" : "s"}**`,
          "",
          ...(lines.length > 0 ? lines : ["No plays recorded yet."]),
        ].join("\n"),
        4096,
      ),
    )
    .setTimestamp(new Date());
}
