import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { toQueueTracks } from "../media/track.js";
import { getMedia, getPlayer } from "../player/registry.js";
import { commandErrorMessage, getMemberVoiceChannel, requestor, respondError } from "./shared.js";
import type { Command } from "./types.js";

export const playCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("Queue a song or playlist")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("Song title, YouTube URL, or playlist URL")
        .setRequired(true)
        .setMaxLength(500),
    ),

  async execute(interaction) {
    if (!interaction.inCachedGuild()) {
      await respondError(interaction, "This command only works in a server.");
      return;
    }

    const voiceChannel = await getMemberVoiceChannel(interaction);
    if (!voiceChannel) {
      await respondError(interaction, "Join a voice channel first, then run /play.");
      return;
    }

    const query = interaction.options.getString("query", true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const player = await getPlayer(interaction.guildId);
      await player.ensureSettings();
      player.setTextChannel(interaction.channelId);
      await player.ensureConnection(voiceChannel);

      const resolved = await getMedia().resolve(query);
      const tracks = toQueueTracks(resolved, requestor(interaction));
      if (tracks.length === 0) {
        await respondError(interaction, "No playable tracks were found.");
        return;
      }

      const added = await player.enqueue(tracks);
      const first = tracks[0];
      if (added === 1 && first) {
        await interaction.editReply({ content: `✅ Added **${first.title}** to the queue.` });
      } else {
        await interaction.editReply({ content: `✅ Added ${added} tracks to the queue.` });
      }
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
