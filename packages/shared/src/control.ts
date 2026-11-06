import { z } from "zod";
import type { GuildSummary, PlayerState } from "./player.js";
import { requestedBySchema } from "./track.js";

export const controlActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("play"),
    query: z.string().min(1).max(500),
    requestedBy: requestedBySchema,
    textChannelId: z.string().optional(),
  }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("skip"), count: z.number().int().min(1).optional() }),
  z.object({ type: z.literal("stop") }),
  z.object({ type: z.literal("seek"), positionSec: z.number().nonnegative() }),
  z.object({ type: z.literal("volume"), volume: z.number().int().min(0).max(200) }),
  z.object({ type: z.literal("loop"), mode: z.enum(["off", "track", "queue"]) }),
  z.object({ type: z.literal("shuffle") }),
  z.object({ type: z.literal("remove"), index: z.number().int().min(0) }),
  z.object({ type: z.literal("move"), from: z.number().int().min(0), to: z.number().int().min(0) }),
  z.object({ type: z.literal("clear") }),
  z.object({ type: z.literal("disconnect") }),
  z.object({
    type: z.literal("playPlaylist"),
    playlistId: z.string().min(1),
    requestedBy: requestedBySchema,
    textChannelId: z.string().optional(),
  }),
]);
export type ControlAction = z.infer<typeof controlActionSchema>;

export type ControlResponse =
  | { ok: true; data: PlayerState }
  | { ok: false; error: { code: string; message: string } };

export type GuildsResponse = { guilds: GuildSummary[] };
