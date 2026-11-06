/** Empty allow-list means every channel is allowed. */
export function isChannelAllowed(allowedChannelIds: readonly string[], channelId: string): boolean {
  if (allowedChannelIds.length === 0) return true;
  return allowedChannelIds.includes(channelId);
}

/** Formats the allow-list as channel mentions for an ephemeral error. */
export function describeAllowedChannels(allowedChannelIds: readonly string[]): string {
  return allowedChannelIds.map((id) => `<#${id}>`).join(", ");
}
