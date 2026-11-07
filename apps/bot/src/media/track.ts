import type { QueueTrack, RequestedBy, TrackSource } from "@music/shared";
import type { ResolvedTrack, TrackInfo } from "./ytdlp.js";

/**
 * `hostname` is `domain` itself or a subdomain of it. String suffixes are not
 * enough: `youtube.com.attacker.tld` and `notyoutube.com` are different hosts.
 * A trailing dot (the absolute-DNS spelling of the same name) is ignored, the
 * same way `isAllowedMediaHost` in `url-guard.ts` treats it.
 */
export function hostMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === domain || host.endsWith(`.${domain}`);
}

function sourceFor(track: ResolvedTrack): TrackSource {
  let url: URL;
  try {
    url = new URL(track.webpageUrl);
  } catch {
    return "unknown";
  }

  if (
    track.videoId !== null ||
    hostMatches(url.hostname, "youtube.com") ||
    hostMatches(url.hostname, "youtu.be")
  ) {
    return "youtube";
  }
  if (/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i.test(url.pathname)) {
    return "direct";
  }
  return "unknown";
}

export function toQueueTrack(track: ResolvedTrack, requestedBy: RequestedBy): QueueTrack {
  return {
    id: track.videoId ?? track.webpageUrl,
    title: track.title,
    artist: track.artist ?? null,
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

/**
 * A title that is really just the pasted id/URL means resolution never found
 * a real title; only then may the download's metadata replace it.
 */
export function titleLooksUnresolved(title: string, url: string): boolean {
  const trimmed = title.trim();
  if (trimmed.length === 0) return true;
  if (trimmed === url.trim()) return true;
  if (/^https?:\/\//i.test(trimmed)) return true;
  // A bare video id: it has id shape and appears verbatim in the URL.
  return /^[A-Za-z0-9_-]{8,32}$/.test(trimmed) && url.includes(trimmed);
}

/**
 * Fill in what the download learned about a queued track. Existing good
 * values win: an enrichment must never degrade a resolved title.
 * Mutates in place (the queue holds the same object the embeds read) and
 * returns whether anything changed.
 */
export function enrichTrack(track: QueueTrack, info: TrackInfo | null): boolean {
  if (!info) return false;
  let changed = false;

  if (info.title && titleLooksUnresolved(track.title, track.url)) {
    track.title = info.title;
    changed = true;
  }
  if (track.durationSec === null && info.durationSec !== null) {
    track.durationSec = Math.max(0, Math.round(info.durationSec));
    changed = true;
  }
  if (track.thumbnailUrl === null && info.thumbnailUrl) {
    track.thumbnailUrl = info.thumbnailUrl;
    changed = true;
  }

  return changed;
}
