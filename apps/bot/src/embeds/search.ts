import {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import type { ResolvedTrack } from "../media/ytdlp.js";
import { COLORS } from "./colors.js";
import { formatDuration, truncate } from "./format.js";

export function buildSearchComponents(
  results: ResolvedTrack[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = results
    .slice(0, 5)
    .map((result, index) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(truncate(result.title, 100))
        .setValue(`${index}`)
        .setDescription(formatDuration(result.durationSec).slice(0, 100)),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("player:search:select")
      .setPlaceholder("Choose a track")
      .addOptions(options),
  );
}

export function buildSearchEmbed(results: ResolvedTrack[], query: string): EmbedBuilder {
  const lines = results.slice(0, 5).map((result, index) => {
    return `${index + 1}. [${truncate(result.title, 90)}](${result.webpageUrl}) · \`${formatDuration(
      result.durationSec,
    )}\``;
  });

  return new EmbedBuilder()
    .setColor(COLORS.idle)
    .setTitle(truncate(`Search results for "${query}"`, 256))
    .setDescription(truncate(lines.length > 0 ? lines.join("\n") : "No results were found.", 4096))
    .setTimestamp(new Date());
}
