import { SlashCommandBuilder } from "discord.js";
import { buildNowPlayingComponents, buildNowPlayingEmbed } from "../embeds/now-playing.js";
import { commandErrorMessage, getPlayerFor, respondError } from "./shared.js";
import type { Command } from "./types.js";

export const nowPlayingCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Show the track that is currently playing"),

  async execute(interaction) {
    try {
      const player = await getPlayerFor(interaction);
      const state = player.getState();
      if (!state.current) {
        await respondError(interaction, "Nothing is playing right now.");
        return;
      }

      await interaction.reply({
        embeds: [
          buildNowPlayingEmbed(state.current, state, {
            guildName: interaction.inCachedGuild() ? interaction.guild.name : undefined,
          }),
        ],
        components: [buildNowPlayingComponents(state)],
      });
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
