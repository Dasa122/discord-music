import { SlashCommandBuilder } from "discord.js";
import { buildQueueComponents, buildQueueEmbed, queuePageCount } from "../embeds/queue.js";
import { commandErrorMessage, getPlayerFor, respondError } from "./shared.js";
import type { Command } from "./types.js";

export const queueCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the queue")
    .addIntegerOption((option) =>
      option.setName("page").setDescription("Page number").setMinValue(1).setRequired(false),
    ),

  async execute(interaction) {
    try {
      const player = await getPlayerFor(interaction);
      const state = player.getState();
      const page = interaction.options.getInteger("page") ?? 1;
      const totalPages = queuePageCount(state.queue.length);

      await interaction.reply({
        embeds: [buildQueueEmbed(state, page)],
        components: [buildQueueComponents(page, totalPages)],
      });
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
