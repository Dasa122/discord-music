import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { formatDuration } from "../embeds/format.js";
import {
  commandErrorMessage,
  getPlayerFor,
  guardDj,
  parseSeekInput,
  respondError,
  respondInfo,
} from "./shared.js";
import type { Command } from "./types.js";

export const seekCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("seek")
    .setDescription("Jump to a position in the current track")
    .addStringOption((option) =>
      option
        .setName("position")
        .setDescription("Position as seconds, mm:ss, or hh:mm:ss")
        .setRequired(true),
    ),

  async execute(interaction) {
    const input = interaction.options.getString("position", true);
    const position = parseSeekInput(input);
    if (position === null) {
      await respondError(interaction, "Use seconds, mm:ss, or hh:mm:ss.");
      return;
    }

    try {
      const player = await getPlayerFor(interaction);
      if (!(await guardDj(interaction, player))) return;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await player.seek(position);
      await respondInfo(interaction, `Seeked to ${formatDuration(position)}.`);
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
