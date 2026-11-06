import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { buildSearchComponents, buildSearchEmbed } from "../embeds/search.js";
import { getMedia } from "../player/registry.js";
import { setSearchResults } from "./search-cache.js";
import { commandErrorMessage, respondError } from "./shared.js";
import type { Command } from "./types.js";

export const searchCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("search")
    .setDescription("Search YouTube and pick a track")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("What to search for")
        .setRequired(true)
        .setMaxLength(500),
    ),

  async execute(interaction) {
    const query = interaction.options.getString("query", true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const results = await getMedia().resolveSearch(query, 5);
      if (results.length === 0) {
        await respondError(interaction, "No results were found.");
        return;
      }

      const message = await interaction.editReply({
        embeds: [buildSearchEmbed(results, query)],
        components: [buildSearchComponents(results)],
      });
      setSearchResults(message.id, results);
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
