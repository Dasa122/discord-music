import { SlashCommandBuilder } from "discord.js";
import { commandErrorMessage, getPlayerFor, guardDj, respondError, respondInfo } from "./shared.js";
import type { Command } from "./types.js";

export const pauseCommand: Command = {
  data: new SlashCommandBuilder().setName("pause").setDescription("Pause playback"),

  async execute(interaction) {
    try {
      const player = await getPlayerFor(interaction);
      if (!(await guardDj(interaction, player))) return;
      player.pause();
      await respondInfo(interaction, "Paused playback.");
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
