export interface ParsedControlId {
  action: string;
  trackId: string | null;
}

/** Button ids are `player:<action>[:<trackId>]`. */
export function parseControlId(customId: string): ParsedControlId | null {
  const [prefix, action, trackId] = customId.split(":");
  if (prefix !== "player" || !action) return null;
  return { action, trackId: trackId ?? null };
}

/**
 * A control button carries the id of the track it was rendered for. A click
 * whose id no longer matches the playing track is stale and must be ignored.
 */
export function isControlForCurrentTrack(
  trackId: string | null,
  currentId: string | null,
): boolean {
  if (trackId === null) return true;
  return trackId === currentId;
}
