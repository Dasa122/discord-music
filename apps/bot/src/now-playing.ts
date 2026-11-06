import type { PlayerState, QueueTrack } from "@music/shared";
import type { Client, GuildTextBasedChannel } from "discord.js";
import { DiscordAPIError } from "discord.js";
import { buildErrorEmbed } from "./embeds/error.js";
import {
  buildFinishedEmbed,
  buildNowPlayingComponents,
  buildNowPlayingEmbed,
} from "./embeds/now-playing.js";
import { logger } from "./logger.js";

const BUTTON_IDLE_MS = 15 * 60 * 1000;
const DEBOUNCE_MS = 750;

interface GuildEntry {
  messageId: string | null;
  textChannelId: string | null;
  lastTrackId: string | null;
  lastTrack: QueueTrack | null;
  lastState: PlayerState | null;
  lastRenderedState: PlayerState | null;
  timer: NodeJS.Timeout | null;
  disableTimer: NodeJS.Timeout | null;
  postedAt: number | null;
  busy: boolean;
}

const entries = new Map<string, GuildEntry>();
let discordClient: Client | null = null;

export function initNowPlaying(client: Client): void {
  discordClient = client;
}

function entryFor(guildId: string): GuildEntry {
  const existing = entries.get(guildId);
  if (existing) return existing;
  const created: GuildEntry = {
    messageId: null,
    textChannelId: null,
    lastTrackId: null,
    lastTrack: null,
    lastState: null,
    lastRenderedState: null,
    timer: null,
    disableTimer: null,
    postedAt: null,
    busy: false,
  };
  entries.set(guildId, created);
  return created;
}

/** Called by every player state change; coalesces bursts into one edit. */
export function notifyStateChange(state: PlayerState): void {
  const entry = entryFor(state.guildId);
  if (state.textChannelId) entry.textChannelId = state.textChannelId;
  entry.lastState = state;

  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void flush(state.guildId);
  }, DEBOUNCE_MS);
  entry.timer.unref?.();
}

async function flush(guildId: string): Promise<void> {
  const entry = entries.get(guildId);
  if (!entry || entry.busy) return;

  entry.busy = true;
  try {
    for (;;) {
      const state = entry.lastState;
      if (!state) return;
      entry.lastState = null;
      await render(entry, state);
      if (!entry.lastState) return;
    }
  } catch (error) {
    logger.warn("now-playing message update failed", {
      guildId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    entry.busy = false;
  }
}

async function render(entry: GuildEntry, state: PlayerState): Promise<void> {
  if (!discordClient) return;
  if (!entry.textChannelId && state.textChannelId) entry.textChannelId = state.textChannelId;

  const track = state.current;
  if (!track) {
    if (entry.messageId) await finalize(entry, entry.lastTrack);
    entry.messageId = null;
    entry.lastTrackId = null;
    entry.lastTrack = null;
    entry.lastRenderedState = null;
    entry.postedAt = null;
    clearDisableTimer(entry);
    return;
  }

  const trackChanged = entry.lastTrackId !== null && entry.lastTrackId !== track.id;
  if (entry.messageId && trackChanged) {
    await finalize(entry, entry.lastTrack);
    entry.messageId = null;
    entry.postedAt = null;
    clearDisableTimer(entry);
  }

  if (entry.messageId) {
    await editMessage(entry, state, false);
  } else {
    await postMessage(entry, state);
  }

  entry.lastTrackId = track.id;
  entry.lastTrack = track;
  entry.lastRenderedState = state;
}

async function postMessage(entry: GuildEntry, state: PlayerState): Promise<void> {
  const track = state.current;
  if (!track) return;
  const channel = await getTextChannel(entry.textChannelId);
  if (!channel) return;

  try {
    const message = await channel.send({
      embeds: [buildNowPlayingEmbed(track, state, nowPlayingMeta(state.guildId))],
      components: [buildNowPlayingComponents(state)],
    });
    entry.messageId = message.id;
    entry.postedAt = Date.now();
    scheduleDisableTimer(entry, state.guildId);
  } catch (error) {
    logger.warn("failed to post now-playing message", {
      guildId: state.guildId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function editMessage(
  entry: GuildEntry,
  state: PlayerState,
  forceDisabled: boolean,
): Promise<void> {
  const track = state.current;
  if (!track || !entry.messageId) return;
  const channel = await getTextChannel(entry.textChannelId);
  if (!channel) return;

  const disabled =
    forceDisabled || (entry.postedAt !== null && Date.now() - entry.postedAt >= BUTTON_IDLE_MS);

  try {
    await channel.messages.edit(entry.messageId, {
      embeds: [buildNowPlayingEmbed(track, state, nowPlayingMeta(state.guildId))],
      components: [buildNowPlayingComponents(state, { disabled })],
    });
  } catch (error) {
    if (isUnknownMessage(error)) {
      entry.messageId = null;
      entry.postedAt = null;
      await postMessage(entry, state);
      return;
    }
    logger.warn("failed to edit now-playing message", {
      guildId: state.guildId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function finalize(entry: GuildEntry, track: QueueTrack | null): Promise<void> {
  const messageId = entry.messageId;
  if (!messageId) return;
  const channel = await getTextChannel(entry.textChannelId);
  if (!channel) {
    entry.messageId = null;
    return;
  }

  try {
    await channel.messages.edit(messageId, {
      embeds: track ? [buildFinishedEmbed(track)] : [],
      components: [],
    });
  } catch (error) {
    if (!isUnknownMessage(error)) {
      logger.warn("failed to finalize now-playing message", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  entry.messageId = null;
}

function nowPlayingMeta(guildId: string): { guildName?: string } {
  const guildName = discordClient?.guilds.cache.get(guildId)?.name;
  return guildName ? { guildName } : {};
}

function scheduleDisableTimer(entry: GuildEntry, guildId: string): void {
  clearDisableTimer(entry);
  entry.disableTimer = setTimeout(() => {
    entry.disableTimer = null;
    const state = entry.lastRenderedState;
    if (!state || !entry.messageId) return;
    void editMessage(entry, state, true).catch((error: unknown) => {
      logger.warn("failed to disable now-playing buttons", {
        guildId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, BUTTON_IDLE_MS);
  entry.disableTimer.unref?.();
}

function clearDisableTimer(entry: GuildEntry): void {
  if (entry.disableTimer) {
    clearTimeout(entry.disableTimer);
    entry.disableTimer = null;
  }
}

async function getTextChannel(channelId: string | null): Promise<GuildTextBasedChannel | null> {
  if (!discordClient || !channelId) return null;
  try {
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel?.isTextBased() || channel.isDMBased()) return null;
    return channel as GuildTextBasedChannel;
  } catch {
    return null;
  }
}

function isUnknownMessage(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError &&
    (error.code === 10_008 || error.code === 10_003 || error.code === 10_015)
  );
}

/** Fire-and-forget playback error embed in the guild's text channel. */
export function notifyPlaybackError(guildId: string, message: string): void {
  const entry = entries.get(guildId);
  const channelId = entry?.textChannelId ?? null;
  if (!channelId) return;

  void getTextChannel(channelId)
    .then((channel) => channel?.send({ embeds: [buildErrorEmbed(message)] }))
    .catch((error: unknown) => {
      logger.warn("failed to send playback error embed", {
        guildId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export function forgetGuild(guildId: string): void {
  const entry = entries.get(guildId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  clearDisableTimer(entry);
  entries.delete(guildId);
}
