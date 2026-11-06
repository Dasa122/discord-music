import { z } from "zod";

export const historyEntrySchema = z.object({
  id: z.string().min(1),
  guildId: z.string().min(1),
  title: z.string().min(1),
  url: z.url(),
  durationSec: z.number().int().nonnegative().nullable(),
  requestedBy: z.string().min(1),
  playedAt: z.iso.datetime(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const historyQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
