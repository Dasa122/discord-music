export type PlaybackSource = "cache" | "stream";

export interface FirstAudioMeasurement {
  ms: number;
  source: PlaybackSource;
  trackId: string;
}

interface Marker {
  trackId: string;
  startedAt: number;
  source: PlaybackSource | null;
}

/**
 * Tracks how long the current track takes to reach its first `Playing`
 * transition. One marker per track: `markPlaying` consumes it, so a pause and
 * resume cannot log the same track twice, and `clear` on skip/stop/endSession
 * prevents a stale timer from leaking into the Next track.
 */
export class FirstAudioTimer {
  private marker: Marker | null = null;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Begin timing a track, replacing any marker that was still open. */
  start(trackId: string): void {
    this.marker = { trackId, startedAt: this.now(), source: null };
  }

  /** Record which path supplied the audio once `open()` has resolved. */
  setSource(trackId: string, source: PlaybackSource): void {
    if (this.marker?.trackId === trackId) this.marker.source = source;
  }

  /**
   * Consume the marker on the first `Playing` transition. A transition for a
   * different resource is ignored: the marker keeps waiting for its own.
   */
  markPlaying(resourceMatches: boolean): FirstAudioMeasurement | null {
    const marker = this.marker;
    if (!marker || !resourceMatches) return null;
    this.marker = null;
    return {
      ms: this.now() - marker.startedAt,
      source: marker.source ?? "stream",
      trackId: marker.trackId,
    };
  }

  clear(): void {
    this.marker = null;
  }

  get active(): boolean {
    return this.marker !== null;
  }
}
