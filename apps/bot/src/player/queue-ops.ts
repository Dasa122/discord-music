import type { LoopMode, QueueTrack } from "@music/shared";

export type TrackEndAction =
  | { type: "replay" }
  | { type: "play"; track: QueueTrack }
  | { type: "empty" };

/**
 * Play history only records real advances: a loop=track replay or a loop=queue
 * repeat of the same track is not a new play.
 */
export function isRealAdvance(previousId: string | null, nextId: string | null): boolean {
  return nextId !== null && nextId !== previousId;
}

/**
 * Pure queue state machine. GuildPlayer owns the audio plumbing; everything
 * that can be decided from the list of tracks lives here so it stays testable.
 */
export class QueueController {
  current: QueueTrack | null = null;
  readonly queue: QueueTrack[] = [];
  loop: LoopMode = "off";

  private readonly rng: () => number;

  constructor(rng: () => number = Math.random) {
    this.rng = rng;
  }

  enqueue(tracks: QueueTrack[], maxLength = 100): number {
    const room = Math.max(0, maxLength - this.queue.length);
    const accepted = tracks.slice(0, room);
    this.queue.push(...accepted);
    return accepted.length;
  }

  next(): QueueTrack | null {
    const track = this.queue.shift() ?? null;
    this.current = track;
    return track;
  }

  onTrackEnd(loop = true): TrackEndAction {
    if (!this.current) return { type: "empty" };

    // `loop = false` means the track did not finish: it must not be replayed
    // from 0 or requeued, only skipped past.
    if (loop && this.loop === "track") return { type: "replay" };
    if (loop && this.loop === "queue") this.queue.push(this.current);

    const next = this.queue.shift() ?? null;
    this.current = next;
    return next ? { type: "play", track: next } : { type: "empty" };
  }

  dropCurrent(): void {
    this.current = null;
  }

  /** Skip the current track plus `count - 1` upcoming tracks. */
  skip(count: number): QueueTrack[] {
    const removed: QueueTrack[] = [];

    if (this.current) {
      removed.push(this.current);
      this.current = null;
    }

    const extra = Math.max(0, Math.trunc(count) - 1);
    for (let index = 0; index < extra; index += 1) {
      const track = this.queue.shift();
      if (!track) break;
      removed.push(track);
    }

    this.current = this.queue.shift() ?? null;
    return removed;
  }

  stop(): void {
    this.current = null;
    this.queue.length = 0;
  }

  clear(): number {
    const length = this.queue.length;
    this.queue.length = 0;
    return length;
  }

  remove(index: number): QueueTrack | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.queue.length) return null;
    const removed = this.queue.splice(index, 1);
    return removed[0] ?? null;
  }

  move(from: number, to: number): boolean {
    const length = this.queue.length;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from < 0 || from >= length || to < 0 || to >= length || from === to) return false;

    const moved = this.queue.splice(from, 1)[0];
    if (!moved) return false;
    this.queue.splice(to, 0, moved);
    return true;
  }

  shuffle(): void {
    for (let index = this.queue.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(this.rng() * (index + 1));
      const current = this.queue[index];
      const other = this.queue[swapIndex];
      if (current !== undefined && other !== undefined) {
        this.queue[index] = other;
        this.queue[swapIndex] = current;
      }
    }
  }

  setLoop(mode: LoopMode): void {
    this.loop = mode;
  }
}
