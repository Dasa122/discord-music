import type { DownloadEntry, DownloadsResponse } from "@music/shared";
import type { AudioStoreMode } from "./audio-store.js";

export type { DownloadEntry, DownloadsResponse } from "@music/shared";
export type DownloadState = DownloadEntry["state"];

export interface DownloadProgress {
  bytes: number;
  totalBytes: number | null;
}

/** What the background cache job reports to the dashboard. */
export interface DownloadReporter {
  begin(sessionId: string, trackId: string, title: string): void;
  progress(trackId: string, progress: DownloadProgress): void;
  ready(trackId: string, result: { bytes: number; gainDb: number | null }): void;
  fail(trackId: string, code: string): void;
  setGain(trackId: string, gainDb: number): void;
}

export interface DownloadRegistryOptions {
  /** `AUDIO_CACHE_MAX_BYTES`. */
  maxBytes: number;
  store: AudioStoreMode;
  now?: () => number;
}

/** Progress writes are coalesced to this interval per track. */
export const PROGRESS_THROTTLE_MS = 500;

interface EntryRecord extends DownloadEntry {
  seq: number;
  startedMs: number;
  lastUpdateMs: number;
}

function percentOf(bytes: number, totalBytes: number | null): number | null {
  if (totalBytes === null || totalBytes <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((bytes / totalBytes) * 100)));
}

/**
 * In-memory download state for one guild's audio session. Cheap to snapshot
 * (the dashboard polls it every 2 s) and dropped when the session ends.
 */
export class DownloadRegistry implements DownloadReporter {
  private readonly maxBytes: number;
  private readonly store: AudioStoreMode;
  private readonly now: () => number;
  private readonly entries = new Map<string, EntryRecord>();
  private sessionId: string | null = null;
  private seq = 0;

  constructor(options: DownloadRegistryOptions) {
    this.maxBytes = options.maxBytes;
    this.store = options.store;
    this.now = options.now ?? Date.now;
  }

  /** Record the active voice session so a snapshot can name it. */
  setSession(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  begin(sessionId: string, trackId: string, title: string): void {
    const now = this.now();
    this.sessionId = sessionId;
    this.seq += 1;
    this.entries.set(trackId, {
      trackId,
      title,
      state: "queued",
      bytes: 0,
      totalBytes: null,
      percent: null,
      startedAt: new Date(now).toISOString(),
      finishedAt: null,
      gainDb: null,
      error: null,
      seq: this.seq,
      startedMs: now,
      lastUpdateMs: now,
    });
  }

  progress(trackId: string, progress: DownloadProgress): void {
    const entry = this.entries.get(trackId);
    if (!entry || entry.state === "ready" || entry.state === "failed") return;

    const now = this.now();
    const transitioning = entry.state !== "downloading";
    if (!transitioning && now - entry.lastUpdateMs < PROGRESS_THROTTLE_MS) return;

    entry.state = "downloading";
    entry.bytes = Math.max(entry.bytes, Math.max(0, Math.floor(progress.bytes)));
    if (progress.totalBytes !== null && progress.totalBytes > 0) {
      entry.totalBytes = progress.totalBytes;
    }
    entry.percent = percentOf(entry.bytes, entry.totalBytes);
    entry.lastUpdateMs = now;
  }

  ready(trackId: string, result: { bytes: number; gainDb: number | null }): void {
    const entry = this.entries.get(trackId);
    if (!entry) return;

    const bytes = Math.max(0, Math.floor(result.bytes));
    entry.state = "ready";
    entry.bytes = bytes;
    entry.totalBytes = entry.totalBytes ?? bytes;
    entry.percent = percentOf(bytes, entry.totalBytes);
    entry.finishedAt = new Date(this.now()).toISOString();
    entry.error = null;
    if (result.gainDb !== null) entry.gainDb = result.gainDb;
  }

  /** Analysis finished after the entry was already ready. */
  setGain(trackId: string, gainDb: number): void {
    const entry = this.entries.get(trackId);
    if (entry) entry.gainDb = gainDb;
  }

  fail(trackId: string, code: string): void {
    const entry = this.entries.get(trackId);
    if (!entry) return;

    entry.state = "failed";
    entry.error = code;
    entry.finishedAt = new Date(this.now()).toISOString();
  }

  snapshot(): DownloadsResponse {
    const records = [...this.entries.values()].sort(
      (a, b) => b.startedMs - a.startedMs || b.seq - a.seq,
    );
    const entries = records.map(
      ({ seq: _seq, startedMs: _startedMs, lastUpdateMs: _lastUpdateMs, ...entry }) => entry,
    );

    let totalBytes = 0;
    for (const entry of entries) {
      if (entry.state === "ready") totalBytes += entry.bytes;
    }

    return {
      sessionId: this.sessionId,
      entries,
      totalBytes,
      maxBytes: this.maxBytes,
      store: this.store,
    };
  }

  clear(): void {
    this.entries.clear();
    this.sessionId = null;
  }
}
