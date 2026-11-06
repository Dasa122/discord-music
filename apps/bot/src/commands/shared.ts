import type { RequestedBy } from "@music/shared";
import {
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  type RepliableInteraction,
  type VoiceBasedChannel,
} from "discord.js";
import { errorMessage, PlayerError } from "../errors.js";
import type { GuildPlayer } from "../player/guild-player.js";
import { getPlayer } from "../player/registry.js";

export type { RepliableInteraction };

export function requestor(interaction: RepliableInteraction): RequestedBy {
  return {
    id: interaction.user.id,
    name: interaction.user.globalName ?? interaction.user.username,
  };
}

export async function getMember(
  interaction: ChatInputCommandInteraction | ButtonInteraction | AnySelectMenuInteraction,
): Promise<GuildMember | null> {
  if (!interaction.inCachedGuild()) return null;
  return interaction.member;
}

export async function getPlayerFor(interaction: ChatInputCommandInteraction): Promise<GuildPlayer> {
  if (!interaction.inCachedGuild()) {
    throw new PlayerError("GUILD_NOT_FOUND", "This command only works in a server.");
  }
  return getPlayer(interaction.guildId);
}

export async function getMemberVoiceChannel(
  interaction: ChatInputCommandInteraction,
): Promise<VoiceBasedChannel | null> {
  const member = await getMember(interaction);
  return member?.voice.channel ?? null;
}

export async function respondError(
  interaction: RepliableInteraction,
  message: string,
): Promise<void> {
  const content = `❌ ${message}`;

  if (interaction.isChatInputCommand()) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content }).catch(() => undefined);
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
    return;
  }

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
}

export async function respondInfo(
  interaction: ChatInputCommandInteraction,
  message: string,
): Promise<void> {
  const content = `✅ ${message}`;
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content }).catch(() => undefined);
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
}

/**
 * DJ gate: skip / stop / clear / remove / move / seek / shuffle / volume.
 * A configured role wins; Manage Guild always passes.
 */
export async function guardDj(
  interaction: ChatInputCommandInteraction,
  player: GuildPlayer,
): Promise<boolean> {
  await player.ensureSettings();
  const { djRoleId } = player.getSettings();
  if (!djRoleId) return true;

  const member = await getMember(interaction);
  if (!member) {
    await respondError(interaction, "Only server members can use that.");
    return false;
  }
  if (member.roles.cache.has(djRoleId)) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;

  await respondError(interaction, "You need the DJ role to use this command.");
  return false;
}

export function parseSeekInput(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const parts = trimmed.split(":").map((part) => part.trim());
  if (parts.length > 3) return null;

  let seconds = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    seconds = seconds * 60 + Number(part);
  }
  return Number.isFinite(seconds) ? seconds : null;
}

export function commandErrorMessage(error: unknown): string {
  return errorMessage(error);
}
