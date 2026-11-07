import { stat as fsStat, unlink as fsUnlink } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../logger.js";
import { type AudioStore, type AudioStoreMode, removeTempDir } from "./audio-store.js";

export interface AudioCacheOptions {
  store: AudioStore;
  mode: AudioStoreMode;
  maxBytes: number;
  /** Object-key prefix (S3 only; empty for local). */
  prefix: string;
  /** Local base directory, used for temp files in local mode. */
  cacheDir: string;
  /** `${TMPDIR:-/tmp}/music-audio`, used for temp files in S3 mode. */
  tempRoot: string;
  statFile?: (path: string) => Promise<{ size: number }>;
  now?: () => number;
}

interface Entry {
  size: number;
  mtimeMs: number;
}

/**
 * Turn an arbitrary track id (YouTube video id or a direct URL) into a stable,
 * path-safe filename component.
 */
export function toCacheId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return safe.length > 0 && safe !== "." && safe !== ".." ? safe : "track";
}

function cleanPrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

/** `${prefix}/${sessionId}/${trackId}.audio` (the prefix is optional for local mode). */
export function audioObjectKey(prefix: string, sessionId: string, trackId: string): string {
  const parts = [cleanPrefix(prefix), sessionId, `${toCacheId(trackId)}.audio`];
  return parts.filter(Boolean).join("/");
}

export function audioSessionPrefix(prefix: string, sessionId: string): string {
  const parts = [cleanPrefix(prefix), sessionId];
  return `${parts.filter(Boolean).join("/")}/`;
}

export function audioRootPrefix(prefix: string): string {
  const cleaned = cleanPrefix(prefix);
  return cleaned ? `${cleaned}/` : "";
}

/** Local downloads land in the cache dir; S3 downloads use the OS temp dir. */
export function audioTempDir(input: {
  mode: AudioStoreMode;
  sessionId: string;
  cacheDir: string;
  tempRoot: string;
}): string {
  return input.mode === "s3"
    ? join(input.tempRoot, input.sessionId)
    : join(input.cacheDir, input.sessionId);
}

/**
 * Session-scoped audio cache. Files live only for one voice session and are
 * deleted by `releaseSession`; every boot wipes what a previous process left.
 * The byte cap is only a safety net for one very long session.
 */
export class AudioCache {
  readonly store: AudioStore;
  readonly mode: AudioStoreMode;
  private readonly maxBytes: number;
  private readonly prefix: string;
  private readonly cacheDir: string;
  private readonly tempRoot: string;
  private readonly statFile: (path: string) => Promise<{ size: number }>;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly pinned = new Set<string>();
  /** trackId -> sessions currently referencing it. */
  private readonly claims = new Map<string, Set<string>>();
  /** sessionId -> tracks it claimed. */
  private readonly sessions = new Map<string, Set<string>>();

  constructor(options: AudioCacheOptions) {
    this.store = options.store;
    this.mode = options.mode;
    this.maxBytes = options.maxBytes;
    this.prefix = options.prefix;
    this.cacheDir = options.cacheDir;
    this.tempRoot = options.tempRoot;
    this.statFile = options.statFile ?? ((path) => fsStat(path));
    this.now = options.now ?? Date.now;
  }

  keyFor(sessionId: string, trackId: string): string {
    return audioObjectKey(this.prefix, sessionId, trackId);
  }

  tempDirFor(sessionId: string): string {
    return audioTempDir({
      mode: this.mode,
      sessionId,
      cacheDir: this.cacheDir,
      tempRoot: this.tempRoot,
    });
  }

  /** Sessions never survive a restart: wipe storage and temp files at boot. */
  async init(): Promise<void> {
    await this.store.health();
    const objects = await this.store.deletePrefix(audioRootPrefix(this.prefix));
    await removeTempDir(this.tempRoot);

    this.entries.clear();
    this.pinned.clear();
    this.claims.clear();
    this.sessions.clear();

    logger.info("cache_cleared", { store: this.mode, objects });
  }

  has(sessionId: string, trackId: string): boolean {
    return this.entries.has(this.keyFor(sessionId, trackId));
  }

  /** Size of a cached object in bytes, or `null` when it is not cached. */
  cachedBytes(sessionId: string, trackId: string): number | null {
    return this.entries.get(this.keyFor(sessionId, trackId))?.size ?? null;
  }

  /** Resolve a cached track to something ffmpeg can read (path or signed URL). */
  async target(sessionId: string, trackId: string): Promise<string | null> {
    const key = this.keyFor(sessionId, trackId);
    const entry = this.entries.get(key);
    if (!entry) return null;

    try {
      const target = await this.store.playbackTarget(key);
      entry.mtimeMs = this.now();
      return target;
    } catch (error) {
      logger.debug("audio cache: could not resolve target", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Upload/move a produced download into the cache, then enforce the cap. */
  async storeFile(sessionId: string, trackId: string, producedPath: string): Promise<void> {
    const key = this.keyFor(sessionId, trackId);
    let size = 0;
    try {
      size = (await this.statFile(producedPath)).size;
    } catch {
      size = 0;
    }

    await this.store.put(key, producedPath);
    this.entries.set(key, { size, mtimeMs: this.now() });

    if (this.mode === "s3") {
      try {
        await fsUnlink(producedPath);
      } catch {
        // Uploaded; a leftover temp file is harmless and cleaned at session end.
      }
    }

    await this.evict();
  }

  async pin(sessionId: string, trackId: string): Promise<void> {
    this.pinned.add(this.keyFor(sessionId, trackId));
  }

  async unpin(sessionId: string, trackId: string): Promise<void> {
    this.pinned.delete(this.keyFor(sessionId, trackId));
  }

  /** Refcount a track against a live session. */
  async claim(sessionId: string, trackId: string): Promise<void> {
    const tracks = this.sessions.get(sessionId) ?? new Set<string>();
    tracks.add(trackId);
    this.sessions.set(sessionId, tracks);

    const owners = this.claims.get(trackId) ?? new Set<string>();
    owners.add(sessionId);
    this.claims.set(trackId, owners);
    this.pinned.add(this.keyFor(sessionId, trackId));
  }

  /** Delete this session's objects and temp files. Other sessions are untouched. */
  async releaseSession(sessionId: string): Promise<void> {
    const prefix = audioSessionPrefix(this.prefix, sessionId);
    const deleted = await this.store.deletePrefix(prefix);

    for (const key of [...this.entries.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.entries.delete(key);
      this.pinned.delete(key);
    }

    for (const trackId of this.sessions.get(sessionId) ?? []) {
      const owners = this.claims.get(trackId);
      owners?.delete(sessionId);
      if (!owners || owners.size === 0) this.claims.delete(trackId);
    }
    this.sessions.delete(sessionId);

    await removeTempDir(this.tempDirFor(sessionId));

    logger.debug("audio cache: released session", { sessionId, objects: deleted });
  }

  /** Evict least-recently-used unpinned objects until the byte cap is met. */
  async evict(): Promise<void> {
    let total = this.totalBytes();
    if (total <= this.maxBytes) return;

    const candidates = [...this.entries.entries()]
      .filter(([key]) => !this.pinned.has(key))
      .sort(([, a], [, b]) => a.mtimeMs - b.mtimeMs);

    for (const [key, entry] of candidates) {
      if (total <= this.maxBytes) break;
      try {
        await this.store.deletePrefix(key);
      } catch (error) {
        logger.debug("audio cache: eviction failed", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.entries.delete(key);
      total -= entry.size;
    }
  }

  async size(): Promise<number> {
    return this.totalBytes();
  }

  async clear(): Promise<void> {
    await this.store.deletePrefix(audioRootPrefix(this.prefix));
    await removeTempDir(this.tempRoot);
    this.entries.clear();
    this.pinned.clear();
    this.claims.clear();
    this.sessions.clear();
  }

  private totalBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.size;
    return total;
  }
}
