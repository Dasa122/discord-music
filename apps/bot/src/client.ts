import {
  ActivityType,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  MessageFlags,
  PermissionFlagsBits,
  type StringSelectMenuInteraction,
} from "discord.js";
import { describeAllowedChannels, isChannelAllowed } from "./commands/channel-access.js";
import { isControlForCurrentTrack, parseControlId } from "./commands/control-id.js";
import { commandByName, commands } from "./commands/index.js";
import { canUsePlayerButtons } from "./commands/permissions.js";
import {
  disabledPlaylistComponents,
  PICKER_EXPIRED_MESSAGE,
  parsePlaylistComponentId,
  planPlaylistAction,
  truncateText,
} from "./commands/play-collection.js";
import { getSearchResults } from "./commands/search-cache.js";
import { commandErrorMessage, guildActor, requestor, respondError } from "./commands/shared.js";
import { config } from "./config.js";
import { buildQueueComponents, buildQueueEmbed, queuePageCount } from "./embeds/queue.js";
import { isGuildAllowed } from "./guild-allowlist.js";
import { logger } from "./logger.js";
import type { MediaEngine } from "./media/media-engine.js";
import { toQueueTrack } from "./media/track.js";
import { initNowPlaying } from "./now-playing.js";
import { pendingCollections } from "./player/pending-collection.js";
import { findPlayer, getPlayer, initRegistry } from "./player/registry.js";

const INTERACTION_MAX_AGE_MS = 15 * 60 * 1000;

export function createDiscordClient(media: MediaEngine): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  initRegistry({ client, media });
  initNowPlaying(client);

  client.once(Events.ClientReady, () => {
    void onReady(client).catch((error: unknown) => {
      logger.error("failed to finish client startup", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction).catch((error: unknown) => {
      logger.error("interaction handler crashed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  client.on(Events.Error, (error) => {
    logger.error("discord client error", { error: error.message });
  });
  client.on(Events.Warn, (message) => {
    logger.warn("discord client warning", { message });
  });

  return client;
}

async function onReady(client: Client): Promise<void> {
  const payload = commands.map((command) => command.data.toJSON());

  if (client.application) {
    if (config.discordGuildId) {
      const guild = await client.guilds.fetch(config.discordGuildId);
      await guild.commands.set(payload);
      logger.info("registered commands in guild", { guildId: guild.id });
    } else {
      await client.application.commands.set(payload);
      logger.info("registered global commands", { count: payload.length });
    }
  }

  client.user?.setPresence({
    status: "online",
    activities: [{ name: "/play", type: ActivityType.Listening }],
  });

  logger.info("bot ready", {
    tag: client.user?.tag,
    guilds: client.guilds.cache.size,
  });
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  try {
    if (!isGuildAllowed(config.allowedGuildIds, interaction.guildId)) {
      warnIgnoredGuild(interaction.guildId ?? "unknown");
      if (interaction.isRepliable()) {
        await respondError(interaction, "This bot is not enabled in this server.");
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      const command = commandByName.get(interaction.commandName);
      if (!command) {
        await respondError(interaction, "Unknown command.");
        return;
      }
      if (!(await enforceChannelAllowlist(interaction))) return;
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("player:")) {
      await handleButton(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "player:search:select") {
      await handleSearchSelect(interaction);
      return;
    }

    if (
      (interaction.isButton() || interaction.isStringSelectMenu()) &&
      interaction.customId.startsWith("playlist:")
    ) {
      await handlePlaylistComponent(interaction);
    }
  } catch (error) {
    logger.error("interaction failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (interaction.isRepliable()) {
      await respondError(interaction, "Something went wrong. Please try again.");
    }
  }
}

function isExpired(interaction: ButtonInteraction): boolean {
  return Date.now() - interaction.message.createdTimestamp > INTERACTION_MAX_AGE_MS;
}

/** Warn once per ignored guild so a busy server cannot flood the log. */
const warnedGuilds = new Set<string>();

function warnIgnoredGuild(guildId: string): void {
  if (warnedGuilds.has(guildId)) return;
  warnedGuilds.add(guildId);
  logger.warn("ignoring interactions from a guild outside DISCORD_ALLOWED_GUILD_IDS", { guildId });
}

/**
 * `allowed_channel_ids` is enforced before any command runs. An empty list means
 * the guild has not restricted commands.
 */
async function enforceChannelAllowlist(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (!interaction.inCachedGuild()) return true;

  const player = await getPlayer(interaction.guildId);
  await player.ensureSettings();
  const allowed = player.getSettings().allowedChannelIds;
  if (isChannelAllowed(allowed, interaction.channelId)) return true;

  await respondError(
    interaction,
    `This command only works in ${describeAllowedChannels(allowed)}.`,
  );
  return false;
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (isExpired(interaction)) {
    await interaction
      .reply({
        content: "This control has expired. Run /nowplaying for fresh controls.",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => undefined);
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await respondError(interaction, "This control only works in a server.");
    return;
  }

  const player = findPlayer(guildId);
  if (!player) {
    await respondError(interaction, "Nothing is playing right now.");
    return;
  }

  const customId = interaction.customId;

  if (customId === "player:queue") {
    const state = player.getState();
    const totalPages = queuePageCount(state.queue.length);
    await interaction.reply({
      embeds: [buildQueueEmbed(state, 1)],
      components: [buildQueueComponents(1, totalPages)],
    });
    return;
  }

  if (customId === "player:queue:prev" || customId === "player:queue:next") {
    const state = player.getState();
    const totalPages = queuePageCount(state.queue.length);
    const current = currentQueuePage(interaction);
    const target = customId === "player:queue:prev" ? current - 1 : current + 1;
    const page = Math.min(Math.max(1, target), totalPages);
    await interaction.update({
      embeds: [buildQueueEmbed(state, page)],
      components: [buildQueueComponents(page, totalPages)],
    });
    return;
  }

  const parsed = parseControlId(customId);
  if (!parsed) {
    await respondError(interaction, "That control is not supported.");
    return;
  }

  if (!isControlForCurrentTrack(parsed.trackId, player.getState().current?.id ?? null)) {
    await respondError(
      interaction,
      "This control is out of date. Run /nowplaying for fresh controls.",
    );
    return;
  }

  if (!interaction.inCachedGuild()) {
    await respondError(interaction, "This control only works in a server.");
    return;
  }

  await player.ensureSettings();
  const djRoleId = player.getSettings().djRoleId;
  const allowed = canUsePlayerButtons(
    {
      ...guildActor(interaction.member, djRoleId),
      voiceChannelId: interaction.member.voice.channelId,
    },
    djRoleId,
    player.voiceChannelId,
  );
  if (!allowed) {
    await respondError(
      interaction,
      "You need the DJ role and to be in the bot's voice channel to use these controls.",
    );
    return;
  }

  // Acknowledge before any player mutation: a slow prebuffer must not let the
  // 3 s interaction window expire underneath us.
  await interaction.deferUpdate().catch(() => undefined);

  try {
    switch (parsed.action) {
      case "pause":
        if (player.getState().paused) player.resume();
        else player.pause();
        break;
      case "skip":
        await player.skip(1);
        break;
      case "stop":
        await player.stop();
        break;
      case "shuffle":
        await player.shuffle();
        break;
      default:
        await respondError(interaction, "That control is not supported.");
    }
  } catch (error) {
    await respondError(interaction, commandErrorMessage(error));
  }
}

function currentQueuePage(interaction: ButtonInteraction): number {
  const description = interaction.message.embeds[0]?.description ?? "";
  const match = /Page (\d+)\/\d+/.exec(description);
  return match?.[1] ? Number(match[1]) : 1;
}

async function handleSearchSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const results = getSearchResults(interaction.message.id);
  if (!results) {
    await respondError(interaction, "That search has expired. Run /search again.");
    return;
  }

  const index = Number.parseInt(interaction.values[0] ?? "", 10);
  const chosen = Number.isInteger(index) ? results[index] : undefined;
  if (!chosen) {
    await respondError(interaction, "That search result is no longer available.");
    return;
  }

  if (!interaction.inCachedGuild()) {
    await respondError(interaction, "This control only works in a server.");
    return;
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    await respondError(interaction, "Join a voice channel first.");
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const player = await getPlayer(interaction.guildId);
    await player.ensureSettings();
    player.setTextChannel(interaction.channelId);
    await player.ensureConnection(voiceChannel);

    const track = toQueueTrack(chosen, requestor(interaction));
    await player.enqueue([track]);
    await interaction.message.edit({ components: [] }).catch(() => undefined);
    await interaction.editReply({ content: `✅ Added **${track.title}** to the queue.` });
  } catch (error) {
    await respondError(interaction, commandErrorMessage(error));
  }
}

/**
 * `/play` collection picker. The token owns the tracks, but the clicker must be
 * the requester (or a server manager). Queueing itself is allowed for anyone
 * who could have run /play, so no DJ role is required here.
 */
async function handlePlaylistComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  const parsed = parsePlaylistComponentId(interaction.customId);
  const isManager = interaction.inCachedGuild()
    ? interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)
    : false;
  const collection = parsed ? pendingCollections.get(parsed.token) : null;

  const plan = planPlaylistAction({
    component: parsed,
    collection,
    userId: interaction.user.id,
    isManager,
    ...(interaction.isStringSelectMenu() ? { values: interaction.values } : {}),
  });

  if (plan.action === "expired" || plan.action === "cancelled") {
    if (parsed) pendingCollections.delete(parsed.token);
    await interaction
      .update({ content: plan.content, embeds: [], components: [] })
      .catch(() => undefined);
    return;
  }

  if (!interaction.inCachedGuild()) {
    await interaction
      .update({ content: PICKER_EXPIRED_MESSAGE, embeds: [], components: [] })
      .catch(() => undefined);
    return;
  }

  // Acknowledge before the (possibly slow) join and enqueue.
  await interaction
    .update({ components: disabledPlaylistComponents(parsed?.token ?? "") })
    .catch(() => undefined);

  const first = plan.tracks[0];
  if (!first || !collection) {
    if (parsed) pendingCollections.delete(parsed.token);
    await interaction
      .editReply({ content: "❌ No playable tracks were found.", components: [] })
      .catch(() => undefined);
    return;
  }

  try {
    const player = await getPlayer(interaction.guildId);
    await player.ensureSettings();
    player.setTextChannel(collection.textChannelId);

    // The voice session may have idled out while the picker was open. Rejoin the
    // clicker's channel rather than enqueueing into a dead player.
    if (!player.voiceChannelId) {
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) {
        await interaction
          .editReply({
            content: "❌ Join a voice channel first, then try again.",
            components: [],
          })
          .catch(() => undefined);
        return;
      }
      await player.ensureConnection(voiceChannel);
    }

    const added = await player.enqueue(plan.tracks);
    if (parsed) pendingCollections.delete(parsed.token);
    await interaction
      .editReply({
        content: `✅ Starting at #${plan.startIndex} — ${truncateText(first.title, 180)} · ${added} track${
          added === 1 ? "" : "s"
        } queued.`,
        components: [],
      })
      .catch(() => undefined);
  } catch (error) {
    if (parsed) pendingCollections.delete(parsed.token);
    await interaction
      .editReply({ content: `❌ ${commandErrorMessage(error)}`, components: [] })
      .catch(() => undefined);
  }
}
