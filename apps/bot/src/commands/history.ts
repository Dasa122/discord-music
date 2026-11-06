import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { countPlayHistory, listPlayHistory } from "../db/client.js";
import { buildHistoryEmbed, clampHistoryPage } from "../embeds/history.js";
import { commandErrorMessage, respondError } from "./shared.js";
import type { Command } from "./types.js";

const PAGE_SIZE = 10;

export const historyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("history")
    .setDescription("Show recently played tracks")
    .addIntegerOption((option) =>
      option.setName("page").setDescription("Page number").setMinValue(1).setRequired(false),
    ),

  async execute(interaction) {
    if (!interaction.inCachedGuild()) {
      await respondError(interaction, "This command only works in a server.");
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const page = clampHistoryPage(interaction.options.getInteger("page") ?? 1);
      const offset = (page - 1) * PAGE_SIZE;
      const [entries, total] = await Promise.all([
        listPlayHistory(interaction.guildId, PAGE_SIZE, offset),
        countPlayHistory(interaction.guildId),
      ]);

      await interaction.editReply({
        embeds: [
          buildHistoryEmbed(
            entries.map((entry) => ({
              title: entry.title,
              url: entry.url,
              requestedBy: entry.requestedBy,
              playedAt: entry.playedAt,
              durationSec: entry.durationSec,
            })),
            page,
            total,
            PAGE_SIZE,
          ),
        ],
      });
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
