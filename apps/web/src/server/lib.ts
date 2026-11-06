/** Small runtime helpers shared by the API routes. */

/** 16-character URL-safe identifier (nanoid-compatible enough for `text` PKs). */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Buffer.from(bytes).toString("base64url");
}

/**
 * True when two id collections describe the same set: same length, no
 * duplicates and every id present on both sides.
 */
export function isSameIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== left.length || rightSet.size !== right.length) return false;
  return right.every((id) => leftSet.has(id));
}

/**
 * A playlist is visible to an admin when they own it or its owner shared it
 * with the guild. Playlist ids are not secrets, so hidden rows must 404.
 */
export function isPlaylistVisible(
  playlist: { ownerDiscordId: string; isShared: boolean },
  viewerSub: string,
): boolean {
  return playlist.ownerDiscordId === viewerSub || playlist.isShared;
}

/** Next append position for a playlist whose current maximum may be unknown. */
export function nextPosition(maxPosition: number | null | undefined): number {
  return (maxPosition ?? -1) + 1;
}

/**
 * Attribute playback actions to the authenticated admin. The dashboard
 * omits `requestedBy`, but a client-supplied value is never trusted: it is
 * always replaced with the session identity so attribution cannot be spoofed.
 */
export function withRequestedByActor(body: unknown, actor: { id: string; name: string }): unknown {
  if (typeof body !== "object" || body === null) return body;
  const candidate = body as Record<string, unknown>;
  const isPlayback = candidate.type === "play" || candidate.type === "playPlaylist";
  if (!isPlayback) return body;
  return { ...candidate, requestedBy: actor };
}
