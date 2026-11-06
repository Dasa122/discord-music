import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

export const guildSettings = pgTable("guild_settings", {
  guildId: text("guild_id").primaryKey(),
  djRoleId: text("dj_role_id"),
  defaultVolume: integer("default_volume").notNull().default(100),
  maxQueueLength: integer("max_queue_length").notNull().default(100),
  allowedChannelIds: text("allowed_channel_ids").array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const playlist = pgTable(
  "playlist",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    ownerDiscordId: text("owner_discord_id").notNull(),
    name: text("name").notNull(),
    isShared: boolean("is_shared").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("playlist_guild_id_name_unique").on(t.guildId, t.name)],
);

export const playlistItem = pgTable(
  "playlist_item",
  {
    id: text("id").primaryKey(),
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlist.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    durationSec: integer("duration_sec"),
    thumbnailUrl: text("thumbnail_url"),
    addedBy: text("added_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("playlist_item_playlist_id_position_idx").on(t.playlistId, t.position)],
);

export const playHistory = pgTable(
  "play_history",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    durationSec: integer("duration_sec"),
    requestedBy: text("requested_by").notNull(),
    playedAt: timestamp("played_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("play_history_guild_played_at_idx").on(t.guildId, t.playedAt.desc())],
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    authentikSub: text("authentik_sub").notNull(),
    displayName: text("display_name").notNull(),
    groups: text("groups").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("session_expires_at_idx").on(t.expiresAt)],
);

export type GuildSettingsRow = typeof guildSettings.$inferSelect;
export type GuildSettingsInsert = typeof guildSettings.$inferInsert;
export type PlaylistRow = typeof playlist.$inferSelect;
export type PlaylistInsert = typeof playlist.$inferInsert;
export type PlaylistItemRow = typeof playlistItem.$inferSelect;
export type PlaylistItemInsert = typeof playlistItem.$inferInsert;
export type PlayHistoryRow = typeof playHistory.$inferSelect;
export type PlayHistoryInsert = typeof playHistory.$inferInsert;
export type SessionRow = typeof session.$inferSelect;
export type SessionInsert = typeof session.$inferInsert;
