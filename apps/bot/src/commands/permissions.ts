/**
 * Pure permission decisions for the DJ gate.
 *
 * Discord objects stay in the callers; these functions take booleans so the
 * rules can be tested without a gateway.
 */

export interface GuildActor {
  hasDjRole: boolean;
  hasManageGuild: boolean;
}

/**
 * DJ gate for commands: an unconfigured DJ role means everyone passes.
 * Manage Guild always passes.
 */
export function canUseDjControls(actor: GuildActor, djRoleId: string | null): boolean {
  if (!djRoleId) return true;
  return actor.hasManageGuild || actor.hasDjRole;
}

/**
 * Now-playing buttons are stricter than commands: on top of the DJ gate the
 * clicker must be in the bot's current voice channel. Manage Guild bypasses
 * both, so an admin can always recover a stuck player.
 */
export function canUsePlayerButtons(
  actor: GuildActor & { voiceChannelId: string | null },
  djRoleId: string | null,
  botVoiceChannelId: string | null,
): boolean {
  if (actor.hasManageGuild) return true;
  if (!canUseDjControls(actor, djRoleId)) return false;
  if (!actor.voiceChannelId || !botVoiceChannelId) return false;
  return actor.voiceChannelId === botVoiceChannelId;
}

/**
 * Playlist authorization.
 *
 * `save`/`delete` need Manage Guild or the DJ role. `delete` additionally needs
 * ownership unless the caller is an admin. `load` only needs visibility:
 * shared, or owned by the caller.
 */
export function canManagePlaylists(actor: GuildActor): boolean {
  return actor.hasManageGuild || actor.hasDjRole;
}

export function canDeletePlaylist(
  actor: GuildActor & { userId: string },
  playlist: { ownerDiscordId: string },
): boolean {
  if (!canManagePlaylists(actor)) return false;
  return actor.hasManageGuild || playlist.ownerDiscordId === actor.userId;
}

export function canLoadPlaylist(
  actor: { userId: string },
  playlist: { ownerDiscordId: string; isShared: boolean },
): boolean {
  return playlist.isShared || playlist.ownerDiscordId === actor.userId;
}
