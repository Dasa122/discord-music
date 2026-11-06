import { SlashCommandBuilder } from "discord.js";
import { commandErrorMessage, getPlayerFor, guardDj, respondError, respondInfo } from "./shared.js";
import type { Command } from "./types.js";

export const moveCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("move")
    .setDescription("Move a queue track to another position")
    .addIntegerOption((option) =>
      option
        .setName("from")
        .setDescription("Current 1-based position")
        .setMinValue(1)
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option.setName("to").setDescription("New 1-based position").setMinValue(1).setRequired(true),
    ),

  async execute(interaction) {
    try {
      const player = await getPlayerFor(interaction);
      if (!(await guardDj(interaction, player))) return;

      const from = interaction.options.getInteger("from", true);
      const to = interaction.options.getInteger("to", true);
      player.move(from - 1, to - 1);
      await respondInfo(interaction, `Moved track ${from} to position ${to}.`);
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
