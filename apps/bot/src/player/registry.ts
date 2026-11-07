import type { GuildSummary } from "@music/shared";
import type { Client } from "discord.js";
import { config } from "../config.js";
import { getGuildSettings, recordPlay } from "../db/client.js";
import { PlayerError } from "../errors.js";
import type { MediaEngine } from "../media/media-engine.js";
import { forgetGuild, notifyPlaybackError, notifyStateChange } from "../now-playing.js";
import { configureStreamLimit, GuildPlayer, globalStreamSemaphore } from "./guild-player.js";

let discordClient: Client | null = null;
let mediaEngine: MediaEngine | null = null;
const players = new Map<string, GuildPlayer>();

export interface RegistryDependencies {
  client: Client;
  media: MediaEngine;
}

export function initRegistry(dependencies: RegistryDependencies): void {
  discordClient = dependencies.client;
  mediaEngine = dependencies.media;
  configureStreamLimit(config.maxConcurrentStreams);
}

function requireClient(): Client {
  if (!discordClient) throw new Error("Player registry has not been initialised.");
  return discordClient;
}

export function getMedia(): MediaEngine {
  if (!mediaEngine) throw new Error("Media engine has not been initialised.");
  return mediaEngine;
}

export function findPlayer(guildId: string): GuildPlayer | null {
  return players.get(guildId) ?? null;
}

export function allPlayers(): GuildPlayer[] {
  return [...players.values()];
}

export async function getPlayer(guildId: string): Promise<GuildPlayer> {
  const existing = players.get(guildId);
  if (existing) return existing;

  const client = requireClient();
  const guild =
    client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) {
    throw new PlayerError("GUILD_NOT_FOUND", "The bot is not a member of that guild.");
  }

  const player = new GuildPlayer({
    guildId,
    media: getMedia(),
    adapterCreator: guild.voiceAdapterCreator,
    semaphore: globalStreamSemaphore,
    idleTimeoutSeconds: config.idleTimeoutSeconds,
    loadSettings: () => getGuildSettings(guildId),
    recordPlay: (track) =>
      recordPlay({
        guildId,
        title: track.title,
        url: track.url,
        durationSec: track.durationSec,
        requestedBy: track.requestedBy.name,
      }),
    getHumanMemberCount: async (channelId) => {
      let channel: Awaited<ReturnType<typeof client.channels.fetch>>;
      try {
        channel = await client.channels.fetch(channelId);
      } catch {
        // Unknown membership: the player reschedules instead of leaving.
        return null;
      }
      if (!channel?.isVoiceBased()) return null;
      return channel.members.filter((member) => !member.user.bot).size;
    },
    onStateChange: (state) => {
      notifyStateChange(state);
    },
    onError: (message) => {
      notifyPlaybackError(guildId, message);
    },
  });

  players.set(guildId, player);
  return player;
}

export async function listGuildSummaries(client: Client): Promise<GuildSummary[]> {
  return [...client.guilds.cache.values()].map((guild) => {
    const state = players.get(guild.id)?.getState() ?? null;
    return {
      id: guild.id,
      name: guild.name,
      iconUrl: guild.iconURL({ size: 128 }),
      memberCount: guild.memberCount,
      connected: state?.connected ?? false,
      playing: state?.playing ?? false,
      currentTitle: state?.current?.title ?? null,
    };
  });
}

export function getClientGuildCount(): number {
  return discordClient?.guilds.cache.size ?? 0;
}

export async function destroyAllPlayers(): Promise<void> {
  for (const [guildId, player] of players) {
    try {
      await player.destroy();
      forgetGuild(guildId);
    } catch {
      // Best effort during shutdown.
    }
  }
  players.clear();
}
