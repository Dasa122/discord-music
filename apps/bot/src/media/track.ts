import type { QueueTrack, RequestedBy, TrackSource } from "@music/shared";
import type { ResolvedTrack } from "./ytdlp.js";

function sourceFor(track: ResolvedTrack): TrackSource {
  const url = track.webpageUrl.toLowerCase();
  if (
    track.videoId !== null ||
    url.includes("youtube.com") ||
    url.includes("youtu.be") ||
    url.includes("music.youtube.com")
  ) {
    return "youtube";
  }
  if (/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)(?:[?#]|$)/i.test(url)) {
    return "direct";
  }
  return "unknown";
}

export function toQueueTrack(track: ResolvedTrack, requestedBy: RequestedBy): QueueTrack {
  return {
    id: track.videoId ?? track.webpageUrl,
    title: track.title,
    url: track.webpageUrl,
    durationSec: track.durationSec === null ? null : Math.max(0, Math.round(track.durationSec)),
    thumbnailUrl: track.thumbnailUrl,
    source: sourceFor(track),
    requestedBy,
  };
}

export function toQueueTracks(track: ResolvedTrack, requestedBy: RequestedBy): QueueTrack[] {
  if (!track.isPlaylist) return [toQueueTrack(track, requestedBy)];
  return (track.entries ?? []).map((entry) => toQueueTrack(entry, requestedBy));
}
