CREATE TABLE "guild_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"dj_role_id" text,
	"default_volume" integer DEFAULT 100 NOT NULL,
	"max_queue_length" integer DEFAULT 100 NOT NULL,
	"allowed_channel_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "play_history" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"duration_sec" integer,
	"requested_by" text NOT NULL,
	"played_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlist" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"owner_discord_id" text NOT NULL,
	"name" text NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playlist_guild_id_name_unique" UNIQUE("guild_id","name")
);
--> statement-breakpoint
CREATE TABLE "playlist_item" (
	"id" text PRIMARY KEY NOT NULL,
	"playlist_id" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"duration_sec" integer,
	"thumbnail_url" text,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"authentik_sub" text NOT NULL,
	"display_name" text NOT NULL,
	"groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playlist_item" ADD CONSTRAINT "playlist_item_playlist_id_playlist_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlist"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "play_history_guild_played_at_idx" ON "play_history" USING btree ("guild_id","played_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "playlist_item_playlist_id_position_idx" ON "playlist_item" USING btree ("playlist_id","position");--> statement-breakpoint
CREATE INDEX "session_expires_at_idx" ON "session" USING btree ("expires_at");