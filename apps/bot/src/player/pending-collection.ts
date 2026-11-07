import { randomUUID } from "node:crypto";
import type { QueueTrack } from "@music/shared";

export const PENDING_COLLECTION_TTL_MS = 5 * 60_000;
export const PENDING_COLLECTION_MAX_ENTRIES = 20;

export interface PendingCollection {
  token: string;
  guildId: string;
  userId: string;
  textChannelId: string;
  /** Collection name for the queued summary. */
  title: string;
  /** `Spotify`, `Apple Music` or `YouTube`. */
  badge: string;
  tracks: QueueTrack[];
  createdAt: number;
}

export interface PendingCollectionInput {
  guildId: string;
  userId: string;
  textChannelId: string;
  title: string;
  badge: string;
  tracks: QueueTrack[];
}

export interface PendingCollectionStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
  createToken?: () => string;
}

/**
 * In-memory pickers awaiting a choice. Bounded (20) and short-lived (5 min), and
 * wiped for a guild when its voice session ends so a dead session cannot queue
 * into a destroyed player.
 */
export class PendingCollectionStore {
  private readonly entries = new Map<string, PendingCollection>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly createToken: () => string;

  constructor(options: PendingCollectionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? PENDING_COLLECTION_TTL_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? PENDING_COLLECTION_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
    this.createToken = options.createToken ?? randomUUID;
  }

  add(input: PendingCollectionInput): PendingCollection {
    this.sweep();
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }

    const token = this.createToken();
    const collection: PendingCollection = {
      token,
      guildId: input.guildId,
      userId: input.userId,
      textChannelId: input.textChannelId,
      title: input.title,
      badge: input.badge,
      tracks: input.tracks,
      createdAt: this.now(),
    };
    this.entries.set(token, collection);
    return collection;
  }

  /** `null` for an unknown or expired token; expired entries are removed. */
  get(token: string): PendingCollection | null {
    this.sweep();
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.entries.delete(token);
      return null;
    }
    return entry;
  }

  delete(token: string): void {
    this.entries.delete(token);
  }

  /** Called when a guild's voice session ends. Returns how many were dropped. */
  clearGuild(guildId: string): number {
    let removed = 0;
    for (const [token, entry] of this.entries) {
      if (entry.guildId === guildId) {
        this.entries.delete(token);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    this.sweep();
    return this.entries.size;
  }

  private isExpired(entry: PendingCollection): boolean {
    return this.now() - entry.createdAt >= this.ttlMs;
  }

  private sweep(): void {
    for (const [token, entry] of this.entries) {
      if (this.isExpired(entry)) this.entries.delete(token);
    }
  }
}

/** The picker owner, or a server manager acting for them. */
export function canUsePendingCollection(
  collection: PendingCollection,
  userId: string,
  isManager = false,
): boolean {
  return collection.userId === userId || isManager;
}

/** One process-wide store shared by /play and the component handler. */
export const pendingCollections = new PendingCollectionStore();
