import type { PlayerState, QueueTrack } from "@music/shared";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { COLORS } from "./colors.js";
import { capitalize, escapeMarkdown, formatDuration, truncate } from "./format.js";

export interface NowPlayingMeta {
  botName?: string;
  guildName?: string;
}

export interface NowPlayingComponentOptions {
  disabled?: boolean;
}

export function buildNowPlayingEmbed(
  track: QueueTrack,
  state: PlayerState,
  meta: NowPlayingMeta = {},
): EmbedBuilder {
  const colour = state.playing ? COLORS.playing : state.paused ? COLORS.paused : COLORS.idle;

  const embed = new EmbedBuilder()
    .setColor(colour)
    .setTitle(truncate(escapeMarkdown(track.title), 256))
    .setURL(track.url)
    .setDescription(`Requested by <@${track.requestedBy.id}>`)
    .addFields(
      { name: "Duration", value: formatDuration(track.durationSec), inline: true },
      {
        name: "Position",
        value: formatDuration(Math.floor(state.positionSec)),
        inline: true,
      },
      { name: "Volume", value: `${state.volume}%`, inline: true },
      { name: "Loop", value: capitalize(state.loop), inline: true },
      {
        name: "Queue",
        value: `${state.queue.length} track${state.queue.length === 1 ? "" : "s"}`,
        inline: true,
      },
    )
    .setFooter({
      text: meta.guildName
        ? `${meta.botName ?? "Music Bot"} • ${meta.guildName}`
        : (meta.botName ?? "Music Bot"),
    })
    .setTimestamp(new Date(state.updatedAt));

  if (track.thumbnailUrl) embed.setThumbnail(track.thumbnailUrl);
  return embed;
}

export function buildNowPlayingComponents(
  state: PlayerState,
  options: NowPlayingComponentOptions = {},
): ActionRowBuilder<ButtonBuilder> {
  const disabled = options.disabled === true;
  const hasTrack = state.current !== null;
  const trackId = state.current?.id ?? "none";

  const pause = new ButtonBuilder()
    .setCustomId(`player:pause:${trackId}`)
    .setLabel(state.paused ? "Resume" : "Pause")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled || !hasTrack);

  const skip = new ButtonBuilder()
    .setCustomId(`player:skip:${trackId}`)
    .setLabel("Skip")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled || !hasTrack);

  const stop = new ButtonBuilder()
    .setCustomId(`player:stop:${trackId}`)
    .setLabel("Stop")
    .setStyle(ButtonStyle.Danger)
    .setDisabled(disabled || !hasTrack);

  const queue = new ButtonBuilder()
    .setCustomId("player:queue")
    .setLabel("Queue")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled || state.queue.length === 0);

  const shuffle = new ButtonBuilder()
    .setCustomId(`player:shuffle:${trackId}`)
    .setLabel("Shuffle")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled || state.queue.length < 2);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(pause, skip, stop, queue, shuffle);
}

export function buildFinishedEmbed(track: QueueTrack, reason = "Finished playing."): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(COLORS.idle)
    .setTitle(truncate(escapeMarkdown(track.title), 256))
    .setURL(track.url)
    .setDescription(reason)
    .setFooter({ text: "Music Bot" })
    .setTimestamp(new Date());

  if (track.thumbnailUrl) embed.setThumbnail(track.thumbnailUrl);
  return embed;
}
