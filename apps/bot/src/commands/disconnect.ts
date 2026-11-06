import { SlashCommandBuilder } from "discord.js";
import { commandErrorMessage, getPlayerFor, respondError, respondInfo } from "./shared.js";
import type { Command } from "./types.js";

export const disconnectCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("disconnect")
    .setDescription("Disconnect the bot from the voice channel"),

  async execute(interaction) {
    try {
      const player = await getPlayerFor(interaction);
      await player.disconnect();
      await respondInfo(interaction, "Disconnected.");
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
