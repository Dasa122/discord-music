import type { QueueTrack } from "@music/shared";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { canUsePendingCollection, type PendingCollection } from "../player/pending-collection.js";

/** Shown whenever a picker's token is gone (already used, expired, or not the clicker's). */
export const PICKER_EXPIRED_MESSAGE = "This picker expired — run /play again.";

/** Rows shown in the preview embed. */
export const PREVIEW_TRACK_LIMIT = 10;
/** A select menu can hold at most 25 options. */
export const PICKER_MENU_LIMIT = 25;
/** Discord's label/description/value ceiling for select options. */
export const DISCORD_OPTION_TEXT_LIMIT = 100;
const EMBED_TITLE_LIMIT = 256;

export type PlaylistStartErrorCode =
  | "START_OPTIONS_CONFLICT"
  | "START_OUT_OF_RANGE"
  | "START_TRACK_NOT_FOUND";

/** A user-supplied start point that cannot be honoured. */
export class PlaylistStartError extends Error {
  readonly code: PlaylistStartErrorCode;

  constructor(code: PlaylistStartErrorCode, message: string) {
    super(message);
    this.name = "PlaylistStartError";
    this.code = code;
  }
}

export interface StartPointOptions {
  /** 1-based track number. */
  startAt?: number;
  /** Case-insensitive substring of the track title. */
  startFrom?: string;
}

export interface StartPoint {
  /** Tracks to queue, from the chosen position onward. */
  tracks: QueueTrack[];
  /** 1-based position of the first queued track in the collection. */
  startIndex: number;
}

function normalize(value: string): string {
  return value.trim();
}

/**
 * Pick where a collection starts. Nothing supplied → the whole collection from
 * #1. A 1-based number or a title substring otherwise. Both at once is a user
 * error, never a silent preference.
 */
export function applyStartPoint(
  entries: QueueTrack[],
  options: StartPointOptions,
  log?: (message: string, fields?: Record<string, unknown>) => void,
): StartPoint {
  const startAt = options.startAt;
  const startFrom = options.startFrom;

  if (startAt !== undefined && startFrom !== undefined) {
    throw new PlaylistStartError(
      "START_OPTIONS_CONFLICT",
      "Use either `start_at` or `start_from`, not both.",
    );
  }

  if (startAt !== undefined) {
    if (!Number.isInteger(startAt) || startAt < 1 || startAt > entries.length) {
      throw new PlaylistStartError(
        "START_OUT_OF_RANGE",
        `Track ${startAt} does not exist — this collection has ${entries.length} track${
          entries.length === 1 ? "" : "s"
        }.`,
      );
    }
    return { tracks: entries.slice(startAt - 1), startIndex: startAt };
  }

  if (startFrom !== undefined) {
    const needle = normalize(startFrom).toLowerCase();
    if (needle === "") return { tracks: entries, startIndex: 1 };
    const matches: number[] = [];
    entries.forEach((track, index) => {
      if (track.title.toLowerCase().includes(needle)) matches.push(index);
    });

    const first = matches[0];
    if (first === undefined) {
      const suggestions = entries
        .slice(0, 5)
        .map((track, index) => `${index + 1}. ${track.title}`)
        .join(", ");
      throw new PlaylistStartError(
        "START_TRACK_NOT_FOUND",
        `No track title contains "${normalize(startFrom)}".${
          suggestions ? ` First tracks: ${suggestions}.` : ""
        }`,
      );
    }
    if (matches.length > 1) {
      log?.("playlist_start_multiple_matches", {
        query: needle,
        matches: matches.length,
        chosen: first + 1,
      });
    }
    return { tracks: entries.slice(first), startIndex: first + 1 };
  }

  return { tracks: entries, startIndex: 1 };
}

/** Trim to a character budget, ending with an ellipsis when shortened. */
export function truncateText(value: string, max: number): string {
  const text = value.trim();
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return text.slice(0, 1);
  return `${text.slice(0, max - 1)}…`;
}

/** `3:42`; unknown durations stay visibly unknown instead of becoming 0:00. */
export function formatTrackDuration(durationSec: number | null | undefined): string {
  if (durationSec === null || durationSec === undefined || durationSec < 0) return "?:??";
  const total = Math.round(durationSec);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const padded = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${padded}`;
  return `${minutes}:${padded}`;
}

export type PlaylistComponentKind = "start" | "all" | "cancel";

/** `playlist:start:<token>` etc. The token never contains a colon. */
export function playlistComponentId(kind: PlaylistComponentKind, token: string): string {
  return `playlist:${kind}:${token}`;
}

export function parsePlaylistComponentId(
  customId: string,
): { kind: PlaylistComponentKind; token: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== "playlist") return null;
  const kind = parts[1];
  const token = parts[2];
  if (!token) return null;
  if (kind !== "start" && kind !== "all" && kind !== "cancel") return null;
  return { kind, token };
}

export interface CollectionPreviewOptions {
  token: string;
  title: string;
  /** `Spotify`, `Apple Music` or `YouTube`. */
  badge: string;
  tracks: QueueTrack[];
}

export interface CollectionPreview {
  embed: EmbedBuilder;
  components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[];
  hasMenu: boolean;
}

function optionDescription(track: QueueTrack): string | null {
  const parts = [formatTrackDuration(track.durationSec), track.artist ?? null].filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );
  return parts.length === 0 ? null : truncateText(parts.join(" · "), DISCORD_OPTION_TEXT_LIMIT);
}

/**
 * The ephemeral picker shown for a multi-track collection when the user gave no
 * start point: a numbered preview, a select menu (only when every track fits in
 * 25 options) and Queue all/Cancel buttons.
 */
export function buildCollectionPreview(options: CollectionPreviewOptions): CollectionPreview {
  const total = options.tracks.length;
  const preview = options.tracks
    .slice(0, PREVIEW_TRACK_LIMIT)
    .map(
      (track, index) =>
        `${index + 1}. ${truncateText(track.title, 80)} — ${formatTrackDuration(track.durationSec)}`,
    )
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle(truncateText(options.title || "Playlist", EMBED_TITLE_LIMIT))
    .setDescription(`${options.badge} · ${total} track${total === 1 ? "" : "s"}\n\n${preview}`);

  const hasMenu = total <= PICKER_MENU_LIMIT;
  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];

  if (hasMenu) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(playlistComponentId("start", options.token))
      .setPlaceholder("Choose a starting track");
    menu.addOptions(
      options.tracks.map((track, index) => {
        const option = new StringSelectMenuOptionBuilder()
          .setLabel(truncateText(`${index + 1}. ${track.title}`, DISCORD_OPTION_TEXT_LIMIT))
          .setValue(String(index + 1));
        const description = optionDescription(track);
        if (description) option.setDescription(description);
        return option;
      }),
    );
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  } else {
    embed.setFooter({ text: "Use start_at to begin later in this list." });
  }

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(playlistComponentId("all", options.token))
      .setLabel("Queue all")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(playlistComponentId("cancel", options.token))
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
  components.push(buttons);

  return { embed, components, hasMenu };
}

/** Remove every control once a choice has been made. */
export function disabledPlaylistComponents(token: string): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(playlistComponentId("all", token))
      .setLabel("Queue all")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(playlistComponentId("cancel", token))
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
  return [row];
}

export type PlaylistPlan =
  | { action: "expired"; content: string }
  | { action: "cancelled"; content: string }
  | { action: "queue"; startIndex: number; tracks: QueueTrack[] };

/**
 * Decide what a picker interaction means without touching Discord. A missing or
 * expired token, or a clicker who does not own the picker, is the same uniform
 * "expired" reply: it leaks nothing about other users' collections.
 */
export function planPlaylistAction(input: {
  component: { kind: PlaylistComponentKind; token: string } | null;
  collection: PendingCollection | null;
  userId: string;
  isManager?: boolean;
  values?: readonly string[];
}): PlaylistPlan {
  const { component, collection } = input;
  if (
    !component ||
    !collection ||
    !canUsePendingCollection(collection, input.userId, input.isManager ?? false)
  ) {
    return { action: "expired", content: PICKER_EXPIRED_MESSAGE };
  }

  if (component.kind === "cancel") {
    return { action: "cancelled", content: "Playlist cancelled." };
  }
  if (component.kind === "all") {
    return { action: "queue", startIndex: 1, tracks: collection.tracks };
  }

  const value = Number.parseInt(input.values?.[0] ?? "", 10);
  if (!Number.isInteger(value) || value < 1 || value > collection.tracks.length) {
    return { action: "expired", content: "That track is no longer available. Run /play again." };
  }
  return { action: "queue", startIndex: value, tracks: collection.tracks.slice(value - 1) };
}
