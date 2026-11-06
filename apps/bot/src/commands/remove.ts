import { SlashCommandBuilder } from "discord.js";
import { commandErrorMessage, getPlayerFor, guardDj, respondError, respondInfo } from "./shared.js";
import type { Command } from "./types.js";

export const removeCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a track from the queue")
    .addIntegerOption((option) =>
      option
        .setName("position")
        .setDescription("1-based queue position")
        .setMinValue(1)
        .setRequired(true),
    ),

  async execute(interaction) {
    try {
      const player = await getPlayerFor(interaction);
      if (!(await guardDj(interaction, player))) return;

      const position = interaction.options.getInteger("position", true);
      const removed = await player.remove(position - 1);
      await respondInfo(interaction, `Removed **${removed.title}** from the queue.`);
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
