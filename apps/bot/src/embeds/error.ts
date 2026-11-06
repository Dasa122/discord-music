import { EmbedBuilder } from "discord.js";
import { COLORS } from "./colors.js";
import { truncate } from "./format.js";

export function buildErrorEmbed(message: string, hint?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(COLORS.error)
    .setTitle("Something went wrong")
    .setDescription(truncate(message, 4096))
    .setTimestamp(new Date());

  if (hint) embed.setFooter({ text: truncate(hint, 2048) });
  return embed;
}
