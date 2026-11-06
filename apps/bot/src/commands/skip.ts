import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { commandErrorMessage, getPlayerFor, guardDj, respondError, respondInfo } from "./shared.js";
import type { Command } from "./types.js";

export const skipCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current track")
    .addIntegerOption((option) =>
      option
        .setName("count")
        .setDescription("How many tracks to skip (default 1)")
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(false),
    ),

  async execute(interaction) {
    const player = await getPlayerFor(interaction).catch(async (error: unknown) => {
      await respondError(interaction, commandErrorMessage(error));
      return null;
    });
    if (!player) return;

    if (!(await guardDj(interaction, player))) return;
    if (!player.getState().current) {
      await respondError(interaction, "Nothing is playing right now.");
      return;
    }

    const count = interaction.options.getInteger("count") ?? 1;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const skipped = await player.skip(count);
      await respondInfo(
        interaction,
        skipped === 1 ? "Skipped the current track." : `Skipped ${skipped} tracks.`,
      );
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
