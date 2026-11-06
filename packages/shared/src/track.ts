import { z } from "zod";

export const trackSourceSchema = z.enum(["youtube", "direct", "unknown"]);
export type TrackSource = z.infer<typeof trackSourceSchema>;

export const requestedBySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type RequestedBy = z.infer<typeof requestedBySchema>;

export const queueTrackSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.url(),
  durationSec: z.number().int().nonnegative().nullable(),
  thumbnailUrl: z.url().nullable(),
  source: trackSourceSchema,
  requestedBy: requestedBySchema,
});
export type QueueTrack = z.infer<typeof queueTrackSchema>;
// The design spec names the same wire type `Track`.
export type Track = QueueTrack;
