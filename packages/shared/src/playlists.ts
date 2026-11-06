import { z } from "zod";

/**
 * Playlist URLs are rendered as masked links and eventually handed to yt-dlp,
 * so only `http(s)` is acceptable — `javascript:`/`data:`/`file:` must never
 * round-trip through the API.
 */
export const playlistUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), {
    message: "Playlist URLs must use http or https",
  });

export const playlistSchema = z.object({
  id: z.string().min(1),
  guildId: z.string().min(1),
  ownerDiscordId: z.string().min(1),
  name: z.string().min(1).max(100),
  isShared: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Playlist = z.infer<typeof playlistSchema>;

export const playlistItemSchema = z.object({
  id: z.string().min(1),
  playlistId: z.string().min(1),
  position: z.number().int().nonnegative(),
  title: z.string().min(1).max(300),
  url: playlistUrlSchema,
  durationSec: z.number().int().nonnegative().nullable(),
  thumbnailUrl: playlistUrlSchema.nullable(),
  addedBy: z.string().min(1),
  createdAt: z.iso.datetime(),
});
export type PlaylistItem = z.infer<typeof playlistItemSchema>;

export const createPlaylistSchema = z.object({
  guildId: z.string().min(1),
  name: z.string().min(1).max(100),
  isShared: z.boolean().optional(),
});
export type CreatePlaylistInput = z.infer<typeof createPlaylistSchema>;

export const updatePlaylistSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  isShared: z.boolean().optional(),
});
export type UpdatePlaylistInput = z.infer<typeof updatePlaylistSchema>;

export const insertPlaylistItemSchema = z.object({
  playlistId: z.string().min(1),
  title: z.string().min(1).max(300),
  url: playlistUrlSchema,
  durationSec: z.number().int().nonnegative().nullable().optional(),
  thumbnailUrl: playlistUrlSchema.nullable().optional(),
});
export type InsertPlaylistItemInput = z.infer<typeof insertPlaylistItemSchema>;

export const reorderPlaylistSchema = z.object({
  playlistId: z.string().min(1),
  orderedItemIds: z.array(z.string().min(1)).min(1),
});
export type ReorderPlaylistInput = z.infer<typeof reorderPlaylistSchema>;
