import type { PlayerState } from "@music/shared";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { COLORS } from "./colors.js";
import { escapeMarkdown, formatDuration, truncate } from "./format.js";

export const QUEUE_PAGE_SIZE = 10;

export function queuePageCount(total: number, pageSize = QUEUE_PAGE_SIZE): number {
  const size = Math.max(1, Math.trunc(pageSize));
  return Math.max(1, Math.ceil(Math.max(0, total) / size));
}

export function clampQueuePage(page: number, totalPages: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.trunc(page)), Math.max(1, totalPages));
}

export function buildQueueEmbed(
  state: PlayerState,
  page: number,
  pageSize = QUEUE_PAGE_SIZE,
): EmbedBuilder {
  const total = state.queue.length;
  const totalPages = queuePageCount(total, pageSize);
  const currentPage = clampQueuePage(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const visible = state.queue.slice(start, start + pageSize);

  const lines = visible.map((track, index) => {
    const position = start + index + 1;
    return `**${position}.** [${truncate(escapeMarkdown(track.title), 80)}](${track.url}) · \`${formatDuration(
      track.durationSec,
    )}\` · <@${track.requestedBy.id}>`;
  });

  const description = [
    `**Page ${currentPage}/${totalPages} · ${total} track${total === 1 ? "" : "s"}**`,
    "",
    ...(lines.length > 0 ? lines : ["The queue is empty."]),
  ].join("\n");

  return new EmbedBuilder()
    .setColor(state.playing ? COLORS.playing : COLORS.idle)
    .setTitle("Queue")
    .setDescription(truncate(description, 4096))
    .setFooter({
      text: state.current
        ? `Now playing: ${truncate(escapeMarkdown(state.current.title), 100)}`
        : "Nothing is playing",
    })
    .setTimestamp(new Date(state.updatedAt));
}

export function buildQueueComponents(
  page: number,
  totalPages: number,
): ActionRowBuilder<ButtonBuilder> {
  const current = clampQueuePage(page, totalPages);

  const previous = new ButtonBuilder()
    .setCustomId("player:queue:prev")
    .setLabel("◀ Previous")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(current <= 1);

  const next = new ButtonBuilder()
    .setCustomId("player:queue:next")
    .setLabel("Next ▶")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(current >= totalPages);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(previous, next);
}
