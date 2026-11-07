import { z } from "zod";

export const downloadStateSchema = z.enum(["queued", "downloading", "ready", "failed"]);

export const downloadEntrySchema = z.object({
  trackId: z.string(),
  title: z.string(),
  state: downloadStateSchema,
  bytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().nullable(),
  percent: z.number().min(0).max(100).nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  gainDb: z.number().nullable(),
  error: z.string().nullable(),
});

export const downloadsResponseSchema = z.object({
  sessionId: z.string().nullable(),
  entries: z.array(downloadEntrySchema),
  totalBytes: z.number().int().nonnegative(),
  maxBytes: z.number().int().positive(),
  store: z.enum(["s3", "local"]),
});
export type DownloadEntry = z.infer<typeof downloadEntrySchema>;
export type DownloadsResponse = z.infer<typeof downloadsResponseSchema>;
