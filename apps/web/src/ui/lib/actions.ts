import type { LoopMode } from "@music/shared";
import type { GuildActionBody } from "./api";
import { clamp } from "./format";

export const playAction = (query: string): GuildActionBody => ({ type: "play", query });

export const pauseAction = (): GuildActionBody => ({ type: "pause" });

export const resumeAction = (): GuildActionBody => ({ type: "resume" });

export const skipAction = (count?: number): GuildActionBody =>
  count === undefined ? { type: "skip" } : { type: "skip", count };

export const stopAction = (): GuildActionBody => ({ type: "stop" });

export const seekAction = (positionSec: number): GuildActionBody => ({
  type: "seek",
  positionSec: Math.max(0, Math.round(positionSec)),
});

export const volumeAction = (volume: number): GuildActionBody => ({
  type: "volume",
  volume: clamp(Math.round(volume), 0, 200),
});

export const loopAction = (mode: LoopMode): GuildActionBody => ({ type: "loop", mode });

export const shuffleAction = (): GuildActionBody => ({ type: "shuffle" });

export const removeAction = (index: number): GuildActionBody => ({ type: "remove", index });

export const moveAction = (from: number, to: number): GuildActionBody => ({
  type: "move",
  from,
  to,
});

export const clearAction = (): GuildActionBody => ({ type: "clear" });

export const disconnectAction = (): GuildActionBody => ({ type: "disconnect" });

export const playPlaylistAction = (playlistId: string): GuildActionBody => ({
  type: "playPlaylist",
  playlistId,
});

const LOOP_ORDER: LoopMode[] = ["off", "track", "queue"];

/** Cycles `off → track → queue → off` for the loop button. */
export function nextLoopMode(mode: LoopMode): LoopMode {
  const index = LOOP_ORDER.indexOf(mode);
  return LOOP_ORDER[(index + 1) % LOOP_ORDER.length] ?? "off";
}
