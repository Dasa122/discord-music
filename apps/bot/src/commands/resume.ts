import { SlashCommandBuilder } from "discord.js";
import { commandErrorMessage, getPlayerFor, guardDj, respondError, respondInfo } from "./shared.js";
import type { Command } from "./types.js";

export const resumeCommand: Command = {
  data: new SlashCommandBuilder().setName("resume").setDescription("Resume playback"),

  async execute(interaction) {
    try {
      const player = await getPlayerFor(interaction);
      if (!(await guardDj(interaction, player))) return;
      player.resume();
      await respondInfo(interaction, "Resumed playback.");
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
