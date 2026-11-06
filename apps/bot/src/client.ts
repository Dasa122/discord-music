import {
  ActivityType,
  type ButtonInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  MessageFlags,
  type StringSelectMenuInteraction,
} from "discord.js";
import { commandByName, commands } from "./commands/index.js";
import { getSearchResults } from "./commands/search-cache.js";
import { commandErrorMessage, requestor, respondError } from "./commands/shared.js";
import { config } from "./config.js";
import { buildQueueComponents, buildQueueEmbed, queuePageCount } from "./embeds/queue.js";
import { logger } from "./logger.js";
import type { MediaEngine } from "./media/media-engine.js";
import { toQueueTrack } from "./media/track.js";
import { initNowPlaying } from "./now-playing.js";
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
    if (interaction.isChatInputCommand()) {
      const command = commandByName.get(interaction.commandName);
      if (!command) {
        await respondError(interaction, "Unknown command.");
        return;
      }
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("player:")) {
      await handleButton(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "player:search:select") {
      await handleSearchSelect(interaction);
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

  try {
    switch (customId) {
      case "player:pause":
        if (player.getState().paused) player.resume();
        else player.pause();
        break;
      case "player:skip":
        await player.skip(1);
        break;
      case "player:stop":
        await player.stop();
        break;
      case "player:shuffle":
        player.shuffle();
        break;
      default:
        await respondError(interaction, "That control is not supported.");
        return;
    }

    // The player emits a state change; the now-playing manager edits the live
    // message. Acknowledge the click so Discord doesn't show a failure.
    await interaction.deferUpdate().catch(() => undefined);
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
