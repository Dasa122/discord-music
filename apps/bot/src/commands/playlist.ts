import type { QueueTrack } from "@music/shared";
import { MessageFlags, SlashCommandBuilder } from "discord.js";
import {
  createPlaylistWithItems,
  deletePlaylistByName,
  getPlaylistByName,
  getPlaylistWithItems,
  listPlaylists,
} from "../db/client.js";
import {
  buildPlaylistDeletedEmbed,
  buildPlaylistListEmbed,
  buildPlaylistLoadedEmbed,
  buildPlaylistSavedEmbed,
} from "../embeds/playlist.js";
import { canDeletePlaylist, canLoadPlaylist, canManagePlaylists } from "./permissions.js";
import {
  commandErrorMessage,
  getMemberVoiceChannel,
  getPlayerFor,
  guildActor,
  requestor,
  respondError,
} from "./shared.js";
import type { Command } from "./types.js";

async function save(interaction: Parameters<Command["execute"]>[0]): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  const name = interaction.options.getString("name", true).trim();

  const player = await getPlayerFor(interaction);
  await player.ensureSettings();

  const actor = guildActor(interaction.member, player.getSettings().djRoleId);
  if (!canManagePlaylists(actor)) {
    await respondError(interaction, "You need the DJ role (or Manage Server) to save playlists.");
    return;
  }

  const state = player.getState();

  // The playing track is deliberately excluded; a saved playlist is the queue.
  const items = state.queue.map((track) => ({
    title: track.title,
    url: track.url,
    durationSec: track.durationSec,
    thumbnailUrl: track.thumbnailUrl,
  }));

  if (items.length === 0) {
    await respondError(
      interaction,
      "The queue is empty. There is nothing to save (the playing track is excluded).",
    );
    return;
  }

  const existing = await getPlaylistByName(interaction.guildId, name);
  if (existing) {
    await respondError(interaction, `A playlist named **${name}** already exists.`);
    return;
  }

  await createPlaylistWithItems({
    guildId: interaction.guildId,
    ownerDiscordId: interaction.user.id,
    name,
    items,
  });

  await interaction.reply({
    embeds: [buildPlaylistSavedEmbed(name, items.length)],
    flags: MessageFlags.Ephemeral,
  });
}

async function load(interaction: Parameters<Command["execute"]>[0]): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  const name = interaction.options.getString("name", true).trim();

  const voiceChannel = await getMemberVoiceChannel(interaction);
  if (!voiceChannel) {
    await respondError(interaction, "Join a voice channel first, then run /playlist load.");
    return;
  }

  const playlist = await getPlaylistByName(interaction.guildId, name);
  if (!playlist) {
    await respondError(interaction, `No playlist named **${name}** exists.`);
    return;
  }

  if (!canLoadPlaylist({ userId: interaction.user.id }, playlist)) {
    await respondError(
      interaction,
      "You can only load your own playlists, or playlists shared with the server.",
    );
    return;
  }

  const loaded = await getPlaylistWithItems(playlist.id, interaction.guildId);
  if (!loaded || loaded.items.length === 0) {
    await respondError(interaction, `**${name}** is empty.`);
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const player = await getPlayerFor(interaction);
    await player.ensureSettings();
    player.setTextChannel(interaction.channelId);
    await player.ensureConnection(voiceChannel);

    const requestedBy = requestor(interaction);
    const tracks: QueueTrack[] = loaded.items.map((item) => ({
      id: item.id,
      title: item.title,
      url: item.url,
      durationSec: item.durationSec,
      thumbnailUrl: item.thumbnailUrl,
      source: "unknown",
      requestedBy,
    }));

    const added = await player.enqueue(tracks);
    await interaction.editReply({
      embeds: [buildPlaylistLoadedEmbed(name, added)],
    });
  } catch (error) {
    await respondError(interaction, commandErrorMessage(error));
  }
}

async function list(interaction: Parameters<Command["execute"]>[0]): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  const playlists = await listPlaylists(interaction.guildId);
  await interaction.reply({
    embeds: [buildPlaylistListEmbed(playlists)],
    flags: MessageFlags.Ephemeral,
  });
}

async function remove(interaction: Parameters<Command["execute"]>[0]): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  const name = interaction.options.getString("name", true).trim();

  const player = await getPlayerFor(interaction);
  await player.ensureSettings();

  const actor = guildActor(interaction.member, player.getSettings().djRoleId);
  if (!canManagePlaylists(actor)) {
    await respondError(interaction, "You need the DJ role (or Manage Server) to delete playlists.");
    return;
  }

  const playlist = await getPlaylistByName(interaction.guildId, name);
  if (!playlist) {
    await respondError(interaction, `No playlist named **${name}** exists.`);
    return;
  }

  if (!canDeletePlaylist({ ...actor, userId: interaction.user.id }, playlist)) {
    await respondError(
      interaction,
      "You can only delete playlists you own, unless you have Manage Server.",
    );
    return;
  }

  const deleted = await deletePlaylistByName(interaction.guildId, name);
  if (!deleted) {
    await respondError(interaction, `No playlist named **${name}** exists.`);
    return;
  }
  await interaction.reply({
    embeds: [buildPlaylistDeletedEmbed(name)],
    flags: MessageFlags.Ephemeral,
  });
}

export const playlistCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("playlist")
    .setDescription("Save, load, list, and delete playlists")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("save")
        .setDescription("Save the current queue as a playlist")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Playlist name")
            .setRequired(true)
            .setMaxLength(100),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("load")
        .setDescription("Queue a saved playlist")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Playlist name")
            .setRequired(true)
            .setMaxLength(100),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("list").setDescription("List this server's playlists"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("delete")
        .setDescription("Delete a saved playlist")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Playlist name")
            .setRequired(true)
            .setMaxLength(100),
        ),
    ),

  async execute(interaction) {
    if (!interaction.inCachedGuild()) {
      await respondError(interaction, "This command only works in a server.");
      return;
    }

    try {
      switch (interaction.options.getSubcommand(true)) {
        case "save":
          await save(interaction);
          break;
        case "load":
          await load(interaction);
          break;
        case "list":
          await list(interaction);
          break;
        case "delete":
          await remove(interaction);
          break;
        default:
          await respondError(interaction, "Unknown playlist subcommand.");
      }
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
