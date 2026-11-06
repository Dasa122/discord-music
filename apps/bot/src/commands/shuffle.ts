import { SlashCommandBuilder } from "discord.js";
import { commandErrorMessage, getPlayerFor, guardDj, respondError, respondInfo } from "./shared.js";
import type { Command } from "./types.js";

export const shuffleCommand: Command = {
  data: new SlashCommandBuilder().setName("shuffle").setDescription("Shuffle the queue"),

  async execute(interaction) {
    try {
      const player = await getPlayerFor(interaction);
      if (!(await guardDj(interaction, player))) return;

      player.shuffle();
      const size = player.getState().queue.length;
      await respondInfo(
        interaction,
        size === 0 ? "The queue is empty." : `Shuffled ${size} tracks.`,
      );
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
