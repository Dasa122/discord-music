import { ClientType, Constants, Innertube, YTNodes } from "youtubei.js";
import { MediaError } from "../../errors.js";
import { logger } from "../../logger.js";
import { isPlaylistUrl, type ResolvedTrack, youtubeVideoIdFromUrl } from "../ytdlp.js";
import { type ResolveOptions, type TrackResolver, UnsupportedQueryError } from "./types.js";

/** The clients the `INNERTUBE_CLIENT` flag exposes. */
export type InnertubeClientType = "IOS" | "ANDROID" | "TV" | "WEB" | "VISIONOS";

const CLIENT_TYPES: Record<InnertubeClientType, ClientType> = {
  IOS: ClientType.IOS,
  ANDROID: ClientType.ANDROID,
  TV: ClientType.TV,
  WEB: ClientType.WEB,
  VISIONOS: ClientType.VISIONOS,
};

/**
 * Search always runs on WEB: the mobile search response parses into a header
 * type this library version rejects (`SearchMobileHeader`), so IOS/ANDROID
 * throw before any result is read. Playback keeps the configured client, which
 * is what decides whether a playable googlevideo URL comes back.
 */
const SEARCH_CLIENT: ClientType = ClientType.WEB;

const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

function thumbnailUrl(
  thumbnails: readonly { url: string; width?: number }[] | undefined,
): string | null {
  if (!thumbnails || thumbnails.length === 0) return null;
  let best = thumbnails[0] ?? null;
  for (const thumbnail of thumbnails) {
    if (!best || (thumbnail.width ?? 0) > (best.width ?? 0)) best = thumbnail;
  }
  return best?.url ?? null;
}

/**
 * A persistent InnerTube client. One session is created per process and reused
 * for every resolve, which is what keeps a resolve at one HTTP round-trip
 * instead of yt-dlp's per-call process + JS-runtime start-up.
 *
 * Both sessions are created lazily so constructing the resolver (and starting
 * the bot) never waits on YouTube.
 */
export class InnertubeResolver implements TrackResolver {
  readonly providesStreamUrls = true;
  private readonly client: InnertubeClientType;
  private searchPromise: Promise<Innertube> | null = null;
  private playerPromise: Promise<Innertube> | null = null;

  constructor(options: { client?: InnertubeClientType } = {}) {
    this.client = options.client ?? "VISIONOS";
  }

  async resolve(query: string, _opts?: ResolveOptions): Promise<ResolvedTrack> {
    const trimmed = query.trim();
    if (!trimmed) throw new MediaError("NOT_FOUND", "The search query is empty.");

    const videoId = youtubeVideoIdFromUrl(trimmed);
    if (videoId) return this.describe(videoId, trimmed);

    // Playlists, direct media URLs and every other site stay on yt-dlp: this
    // resolver speaks YouTube video ids only.
    if (isPlaylistUrl(trimmed) || URL_PATTERN.test(trimmed)) {
      throw new UnsupportedQueryError(`The innertube resolver cannot handle "${trimmed}".`);
    }

    const results = await this.resolveSearch(trimmed, 1);
    const first = results[0];
    if (!first?.videoId) {
      throw new MediaError("NOT_FOUND", `No YouTube results for "${trimmed}".`);
    }
    return this.describe(first.videoId, first.webpageUrl);
  }

  async resolveSearch(query: string, limit: number): Promise<ResolvedTrack[]> {
    const trimmed = query.trim();
    if (!trimmed) throw new MediaError("NOT_FOUND", "The search query is empty.");

    const yt = await this.searchSession();
    const search = await yt.search(trimmed, { type: "video" });
    const bounded = Math.max(1, Math.min(10, Math.trunc(limit)));

    // `videos` is every video-shaped node the response happens to contain;
    // only `Video` carries the fields this resolver promises.
    const videos = search.videos.filter((node) => node.is(YTNodes.Video));

    return videos.slice(0, bounded).map((video) => ({
      videoId: video.video_id,
      title: video.title.toString(),
      webpageUrl: `https://www.youtube.com/watch?v=${video.video_id}`,
      durationSec: video.duration.seconds || null,
      thumbnailUrl: video.best_thumbnail?.url ?? thumbnailUrl(video.thumbnails),
      isPlaylist: false,
    }));
  }

  /** One player response: metadata, the audio format, and its signed URL. */
  private async describe(videoId: string, fallbackUrl: string): Promise<ResolvedTrack> {
    const yt = await this.playerSession();
    const info = await yt.getBasicInfo(videoId);

    const status = info.playability_status;
    if (status?.status !== "OK") {
      throw new MediaError(
        "EXTRACTOR_FAILED",
        `YouTube refused "${videoId}": ${status?.reason ?? status?.status ?? "no playability status"}`,
      );
    }

    const basic = info.basic_info;
    const metadata = {
      videoId: basic.id ?? videoId,
      title: basic.title ?? fallbackUrl,
      webpageUrl: `https://www.youtube.com/watch?v=${videoId}`,
      durationSec: basic.duration ?? null,
      thumbnailUrl: thumbnailUrl(basic.thumbnail),
      isPlaylist: false,
    };

    // A live stream is served as an OTF/HLS playlist, not a single file ffmpeg
    // can open with `-i`, so it keeps the yt-dlp path.
    if (basic.is_live === true || basic.is_live_content === true) return metadata;

    const format = info.chooseFormat({ type: "audio", quality: "best" });
    if (!format) {
      throw new MediaError("EXTRACTOR_FAILED", `No audio format for "${videoId}".`);
    }
    const streamUrl = await format.decipher(yt.session.player);
    if (!streamUrl) {
      throw new MediaError("EXTRACTOR_FAILED", `No playable URL for "${videoId}".`);
    }

    return {
      ...metadata,
      streamUrl,
      headers: this.streamHeaders(),
    };
  }

  /**
   * The User-Agent that matches the URL's client. `session.context` keeps the
   * browser UA of the locally generated session data, so it is not usable here;
   * the client table is the source of truth for what googlevideo expects.
   */
  private streamHeaders(): Record<string, string> | undefined {
    // The table is a union of per-client literals and not every entry declares
    // a UA, so read the one property this resolver needs.
    const client = Constants.CLIENTS?.[this.client] as { USER_AGENT?: string } | undefined;
    return client?.USER_AGENT ? { "User-Agent": client.USER_AGENT } : undefined;
  }

  private searchSession(): Promise<Innertube> {
    this.searchPromise ??= this.createSession(SEARCH_CLIENT, "search").catch((error: unknown) => {
      // A failed session is retried next time instead of staying rejected for
      // the life of the process.
      this.searchPromise = null;
      throw error;
    });
    return this.searchPromise;
  }

  private playerSession(): Promise<Innertube> {
    this.playerPromise ??= this.createSession(CLIENT_TYPES[this.client], this.client).catch(
      (error: unknown) => {
        this.playerPromise = null;
        throw error;
      },
    );
    return this.playerPromise;
  }

  private async createSession(clientType: ClientType, label: string): Promise<Innertube> {
    const startedAt = Date.now();
    const session = await Innertube.create({
      client_type: clientType,
      // Session data must come from YouTube: a locally fabricated visitor id
      // gets the IP flagged with "Sign in to confirm you're not a bot" after a
      // few player requests, while the real one keeps resolving.
      generate_session_locally: false,
      enable_session_cache: false,
    });
    logger.info("innertube_session_ready", { client: label, ms: Date.now() - startedAt });
    return session;
  }
}

export function createInnertubeResolver(
  options: { client?: InnertubeClientType } = {},
): TrackResolver {
  return new InnertubeResolver(options);
}
