import { z } from "zod";
import { queueTrackSchema } from "./track.js";

export const loopModeSchema = z.enum(["off", "track", "queue"]);
export type LoopMode = z.infer<typeof loopModeSchema>;

export const playerStateSchema = z.object({
  guildId: z.string().min(1),
  connected: z.boolean(),
  voiceChannelId: z.string().nullable(),
  textChannelId: z.string().nullable(),
  playing: z.boolean(),
  paused: z.boolean(),
  positionSec: z.number().nonnegative(),
  volume: z.number().int().min(0).max(200),
  loop: loopModeSchema,
  current: queueTrackSchema.nullable(),
  queue: z.array(queueTrackSchema),
  updatedAt: z.iso.datetime(),
});
export type PlayerState = z.infer<typeof playerStateSchema>;

export const guildSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  iconUrl: z.url().nullable(),
  memberCount: z.number().int().nonnegative(),
  connected: z.boolean(),
  playing: z.boolean(),
  currentTitle: z.string().nullable(),
});
export type GuildSummary = z.infer<typeof guildSummarySchema>;
