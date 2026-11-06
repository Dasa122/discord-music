import { z } from "zod";

export const guildSettingsSchema = z.object({
  guildId: z.string().min(1),
  djRoleId: z.string().nullable(),
  defaultVolume: z.number().int().min(0).max(200),
  maxQueueLength: z.number().int().min(1).max(1000),
  allowedChannelIds: z.array(z.string()),
});
export type GuildSettings = z.infer<typeof guildSettingsSchema>;

export const guildSettingsUpdateSchema = z.object({
  djRoleId: z.string().nullable().optional(),
  defaultVolume: z.number().int().min(0).max(200).optional(),
  maxQueueLength: z.number().int().min(1).max(1000).optional(),
  allowedChannelIds: z.array(z.string()).optional(),
});
export type GuildSettingsUpdate = z.infer<typeof guildSettingsUpdateSchema>;
