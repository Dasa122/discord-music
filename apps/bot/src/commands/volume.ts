import { SlashCommandBuilder } from "discord.js";
import { commandErrorMessage, getPlayerFor, guardDj, respondError, respondInfo } from "./shared.js";
import type { Command } from "./types.js";

export const volumeCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Set the playback volume")
    .addIntegerOption((option) =>
      option
        .setName("level")
        .setDescription("Volume from 0 to 200")
        .setMinValue(0)
        .setMaxValue(200)
        .setRequired(true),
    ),

  async execute(interaction) {
    try {
      const player = await getPlayerFor(interaction);
      if (!(await guardDj(interaction, player))) return;

      const level = interaction.options.getInteger("level", true);
      const applied = await player.setVolume(level);
      await respondInfo(interaction, `Volume set to ${applied}%.`);
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
