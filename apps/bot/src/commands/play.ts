import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import { logger } from "../logger.js";
import { checkCommandRateLimit } from "../media/limits.js";
import { parseMusicLink } from "../media/providers/index.js";
import { toQueueTracks } from "../media/track.js";
import { pendingCollections } from "../player/pending-collection.js";
import { getMedia, getPlayer } from "../player/registry.js";
import {
  applyStartPoint,
  buildCollectionPreview,
  PlaylistStartError,
  truncateText,
} from "./play-collection.js";
import { startPlayInParallel } from "./play-start.js";
import { commandErrorMessage, getMemberVoiceChannel, requestor, respondError } from "./shared.js";
import type { Command } from "./types.js";

/** `Spotify` / `Apple Music` badge for the picker embed. */
function collectionBadge(query: string): string {
  const detected = parseMusicLink(query);
  if (detected?.provider === "spotify") return "Spotify";
  if (detected?.provider === "applemusic") return "Apple Music";
  return "YouTube";
}

function startingEmbed(input: {
  startIndex: number;
  title: string;
  queued: number;
  total: number;
  badge: string;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`Starting at #${input.startIndex} — ${truncateText(input.title, 200)}`)
    .setDescription(`Queued ${input.queued} of ${input.total} tracks.`)
    .setFooter({ text: input.badge });
}

export const playCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("Queue a song, playlist, album, or a Spotify/Apple Music link")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("Song title, YouTube link, or a Spotify/Apple Music link")
        .setRequired(true)
        .setMaxLength(500),
    )
    .addIntegerOption((option) =>
      option
        .setName("start_at")
        .setDescription("For a playlist/album: start at this track number")
        .setMinValue(1)
        .setMaxValue(500)
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName("start_from")
        .setDescription("For a playlist/album: start at the first title containing this text")
        .setMinLength(1)
        .setMaxLength(100)
        .setRequired(false),
    ),

  async execute(interaction) {
    if (!interaction.inCachedGuild()) {
      await respondError(interaction, "This command only works in a server.");
      return;
    }

    const startAt = interaction.options.getInteger("start_at") ?? undefined;
    const startFrom = interaction.options.getString("start_from") ?? undefined;
    if (startAt !== undefined && startFrom !== undefined) {
      await respondError(interaction, "Use either `start_at` or `start_from`, not both.");
      return;
    }

    const waitSeconds = checkCommandRateLimit(interaction.guildId, interaction.user.id);
    if (waitSeconds > 0) {
      await respondError(interaction, `You're doing that too often. Try again in ${waitSeconds}s.`);
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

      const startedAt = Date.now();
      // Publish the session id before resolving so the cache-first path can
      // still hit, then join and resolve together.
      const sessionId = player.beginSession();
      const { resolved, resolveMs } = await startPlayInParallel({
        join: () => player.ensureConnection(voiceChannel),
        resolve: () => getMedia().resolve(query, sessionId),
        onJoinFailure: () => player.endSession(),
      });

      const tracks = toQueueTracks(resolved, requestor(interaction));
      if (tracks.length === 0) {
        await respondError(interaction, "No playable tracks were found.");
        return;
      }

      const enqueueStartedAt = Date.now();

      // An explicit start point applies to every collection, provider or not.
      if (startAt !== undefined || startFrom !== undefined) {
        let point: ReturnType<typeof applyStartPoint>;
        try {
          point = applyStartPoint(tracks, { startAt, startFrom }, (message, fields) =>
            logger.debug(message, fields),
          );
        } catch (error) {
          if (error instanceof PlaylistStartError) {
            await respondError(interaction, error.message);
            return;
          }
          throw error;
        }

        const added = await player.enqueue(point.tracks);
        const first = point.tracks[0];
        if (!first) {
          await respondError(interaction, "No playable tracks were found.");
          return;
        }
        await interaction.editReply({
          embeds: [
            startingEmbed({
              startIndex: point.startIndex,
              title: first.title,
              queued: added,
              total: tracks.length,
              badge: collectionBadge(query),
            }),
          ],
        });

        logger.debug("play_timing", {
          guildId: interaction.guildId,
          resolveMs,
          enqueueMs: Date.now() - enqueueStartedAt,
          totalMs: Date.now() - startedAt,
          startIndex: point.startIndex,
        });
        return;
      }

      // A single track keeps today's behaviour: queue it and reply.
      if (tracks.length === 1) {
        const added = await player.enqueue(tracks);
        const first = tracks[0];
        if (added === 1 && first) {
          await interaction.editReply({ content: `✅ Added **${first.title}** to the queue.` });
        } else {
          await interaction.editReply({ content: `✅ Added ${added} tracks to the queue.` });
        }

        logger.debug("play_timing", {
          guildId: interaction.guildId,
          resolveMs,
          enqueueMs: Date.now() - enqueueStartedAt,
          totalMs: Date.now() - startedAt,
        });
        return;
      }

      // A multi-track collection without a start point: show the picker instead
      // of queueing everything blindly.
      const badge = collectionBadge(query);
      const collection = pendingCollections.add({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        textChannelId: interaction.channelId,
        title: resolved.title || "Playlist",
        badge,
        tracks,
      });
      const preview = buildCollectionPreview({
        token: collection.token,
        title: collection.title,
        badge,
        tracks,
      });
      await interaction.editReply({
        embeds: [preview.embed],
        components: preview.components,
      });
      logger.debug("playlist_picker_shown", {
        guildId: interaction.guildId,
        tracks: tracks.length,
        menu: preview.hasMenu,
        totalMs: Date.now() - startedAt,
      });
    } catch (error) {
      await respondError(interaction, commandErrorMessage(error));
    }
  },
};
