import { SlashCommandBuilder } from "discord.js";
import { commandErrorMessage, getPlayerFor, guardDj, respondError, respondInfo } from "./shared.js";
import type { Command } from "./types.js";

export const clearCommand: Command = {
  data: new SlashCommandBuilder().setName("clear").setDescription("Clear the queue"),

  async execute(interaction) {
    try {
      const player = await getPlayerFor(interaction);
      if (!(await guardDj(interaction, player))) return;

      const cleared = await player.clear();
      await respondInfo(
        interaction,
        cleared === 0 ? "The queue was already empty." : `Cleared ${cleared} tracks.`,
      );
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
