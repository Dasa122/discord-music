import { EmbedBuilder } from "discord.js";
import { COLORS } from "./colors.js";
import { truncate } from "./format.js";

export interface PlaylistSummaryView {
  name: string;
  isShared?: boolean;
  itemCount?: number;
}

export function buildPlaylistListEmbed(playlists: PlaylistSummaryView[]): EmbedBuilder {
  const lines = playlists.map((playlist) => {
    const shared = playlist.isShared ? " · shared" : "";
    const count =
      playlist.itemCount === undefined
        ? ""
        : ` · ${playlist.itemCount} item${playlist.itemCount === 1 ? "" : "s"}`;
    return `• **${truncate(playlist.name, 100)}**${count}${shared}`;
  });

  return new EmbedBuilder()
    .setColor(COLORS.idle)
    .setTitle("Playlists")
    .setDescription(truncate(lines.length > 0 ? lines.join("\n") : "No playlists yet.", 4096))
    .setTimestamp(new Date());
}

export function buildPlaylistSavedEmbed(name: string, itemCount: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.playing)
    .setTitle("Playlist saved")
    .setDescription(
      `Saved **${truncate(name, 100)}** with ${itemCount} track${itemCount === 1 ? "" : "s"}.`,
    )
    .setTimestamp(new Date());
}

export function buildPlaylistLoadedEmbed(name: string, itemCount: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.playing)
    .setTitle("Playlist loaded")
    .setDescription(
      `Queued ${itemCount} track${itemCount === 1 ? "" : "s"} from **${truncate(name, 100)}**.`,
    )
    .setTimestamp(new Date());
}

export function buildPlaylistDeletedEmbed(name: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.idle)
    .setTitle("Playlist deleted")
    .setDescription(`Deleted **${truncate(name, 100)}**.`)
    .setTimestamp(new Date());
}
