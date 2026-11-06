import { SlashCommandBuilder } from "discord.js";
import { commandErrorMessage, getPlayerFor, guardDj, respondError, respondInfo } from "./shared.js";
import type { Command } from "./types.js";

export const loopCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Set the loop mode")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("What to repeat")
        .setRequired(true)
        .addChoices(
          { name: "Off", value: "off" },
          { name: "Track", value: "track" },
          { name: "Queue", value: "queue" },
        ),
    ),

  async execute(interaction) {
    try {
      const player = await getPlayerFor(interaction);
      if (!(await guardDj(interaction, player))) return;

      const value = interaction.options.getString("mode", true);
      const mode = value === "track" || value === "queue" ? value : "off";
      await player.setLoop(mode);
      await respondInfo(interaction, `Loop mode set to **${mode}**.`);
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
