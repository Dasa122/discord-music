import { randomUUID } from "node:crypto";
import {
  type AudioPlayer,
  AudioPlayerStatus,
  type AudioResource,
  createAudioPlayer,
  createAudioResource,
  type DiscordGatewayAdapterCreator,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import type { GuildSettings, LoopMode, PlayerState, QueueTrack } from "@music/shared";
import { isTransientPlaybackError, MediaError, PlayerError } from "../errors.js";
import { logger, sanitizeProcessOutput } from "../logger.js";
import type { DownloadRegistry, DownloadsResponse } from "../media/download-registry.js";
import type { MediaEngine, OpenedStream } from "../media/media-engine.js";
import { enrichTrack } from "../media/track.js";
import {
  endsSession,
  failureNotice,
  isSettingsStale,
  isSuppressedIdle,
  SETTINGS_TTL_MS,
  shouldIdleDisconnect,
  startBlocker,
  VOICE_DISCONNECT_GRACE_MS,
  voiceTransitionAction,
} from "./lifecycle.js";
import { isRealAdvance, QueueController } from "./queue-ops.js";

export class StreamSemaphore {
  private active = 0;
  private limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  tryAcquire(): boolean {
    if (this.active >= this.limit) return false;
    this.active += 1;
    return true;
  }

  release(): void {
    if (this.active > 0) this.active -= 1;
  }

  hasCapacity(): boolean {
    return this.active < this.limit;
  }

  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.trunc(limit));
  }

  get inUse(): number {
    return this.active;
  }
}

/**
 * Generation-tagged ownership of one global stream slot. A stream that was
 * already torn down holds a stale token, so its late release cannot free the
 * slot that a newer stream acquired.
 */
export class SlotLease {
  private readonly semaphore: StreamSemaphore;
  private generation = 0;
  private held: number | null = null;

  constructor(semaphore: StreamSemaphore) {
    this.semaphore = semaphore;
  }

  acquire(): number | null {
    if (this.held !== null) return this.held;
    if (!this.semaphore.tryAcquire()) return null;
    this.generation += 1;
    this.held = this.generation;
    return this.held;
  }

  release(generation: number | null = this.held): void {
    if (generation === null || generation !== this.held) return;
    this.held = null;
    this.semaphore.release();
  }

  get current(): number | null {
    return this.held;
  }

  get holdsSlot(): boolean {
    return this.held !== null;
  }
}

/** One shared budget across every guild in this process. */
export const globalStreamSemaphore = new StreamSemaphore(3);

export function configureStreamLimit(limit: number): void {
  globalStreamSemaphore.setLimit(limit);
}

export interface GuildPlayerOptions {
  guildId: string;
  media: MediaEngine;
  /** Per-guild download state reported over the control API. */
  downloads: DownloadRegistry;
  adapterCreator: DiscordGatewayAdapterCreator;
  loadSettings?: () => Promise<GuildSettings>;
  recordPlay?: (track: QueueTrack) => Promise<void>;
  /** `null` means the member count is unknown (e.g. the channel fetch failed). */
  getHumanMemberCount?: (channelId: string) => Promise<number | null>;
  onStateChange?: (state: PlayerState) => void;
  onError?: (message: string) => void;
  idleTimeoutSeconds?: number;
  semaphore?: StreamSemaphore;
  rng?: () => number;
}

const DEFAULT_SETTINGS_VOLUME = 100;
const DEFAULT_MAX_QUEUE_LENGTH = 100;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 60;
const FAILURE_WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 60_000;

export class GuildPlayer {
  readonly guildId: string;
  readonly audioPlayer: AudioPlayer;

  voiceChannelId: string | null = null;
  textChannelId: string | null = null;
  nowPlayingMessageId: string | null = null;
  connection: VoiceConnection | null = null;

  private readonly options: GuildPlayerOptions;
  private readonly queue: QueueController;
  private readonly semaphore: StreamSemaphore;
  private readonly slotLease: SlotLease;
  private readonly idleTimeoutSeconds: number;

  private settings: GuildSettings;
  private settingsLoadedAt: number | null = null;
  private settingsLoad: Promise<void> | null = null;
  private opened: OpenedStream | null = null;
  private resource: AudioResource | null = null;
  private playing = false;
  private paused = false;
  private startedAt: number | null = null;
  private basePositionSec = 0;
  private pausedAt: number | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private disconnectTimer: NodeJS.Timeout | null = null;
  /** The resource we stopped on purpose; its Idle event must not advance the queue. */
  private expectedStopResource: AudioResource | null = null;
  private failureTimes: number[] = [];
  private consecutiveFailures = 0;
  private cooldownUntil = 0;
  private handlingFailure = false;
  private destroyed = false;
  private volumeValue = DEFAULT_SETTINGS_VOLUME;
  private maxQueueLength = DEFAULT_MAX_QUEUE_LENGTH;
  /** One voice session; the audio cache is scoped to it. */
  private sessionId: string | null = null;
  private pinnedTrackId: string | null = null;
  /** True while a deferred playback start is queued or running. */
  private isStarting = false;
  /** Serializes every mutating command so two guild actions never interleave. */
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: GuildPlayerOptions) {
    this.options = options;
    this.guildId = options.guildId;
    this.queue = new QueueController(options.rng);
    this.semaphore = options.semaphore ?? globalStreamSemaphore;
    this.slotLease = new SlotLease(this.semaphore);
    this.idleTimeoutSeconds = options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
    this.settings = {
      guildId: options.guildId,
      djRoleId: null,
      defaultVolume: DEFAULT_SETTINGS_VOLUME,
      maxQueueLength: DEFAULT_MAX_QUEUE_LENGTH,
      allowedChannelIds: [],
    };

    this.audioPlayer = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this.audioPlayer.on("stateChange", (oldState, newState) => {
      const previousResource = "resource" in oldState ? (oldState.resource ?? null) : null;
      this.onPlayerStateChange(oldState.status, newState.status, previousResource);
    });
    this.audioPlayer.on("error", (error) => {
      if (!this.queue.current || this.destroyed) return;
      void this.serialized(() => this.handlePlaybackFailure(error, true));
    });
  }

  // ---------------------------------------------------------------- settings

  getSettings(): GuildSettings {
    return this.settings;
  }

  async ensureSettings(): Promise<void> {
    if (!this.options.loadSettings) return;
    if (this.settingsLoad) return this.settingsLoad;
    if (!isSettingsStale(this.settingsLoadedAt, Date.now(), SETTINGS_TTL_MS)) return;

    const load = this.options
      .loadSettings()
      .then((settings) => {
        this.settings = settings;
        this.maxQueueLength = settings.maxQueueLength;
        if (!this.playing) this.volumeValue = settings.defaultVolume;
      })
      .catch((error: unknown) => {
        logger.warn("failed to load guild settings; using defaults", {
          guildId: this.guildId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.settingsLoadedAt = Date.now();
        this.settingsLoad = null;
      });

    this.settingsLoad = load;
    return load;
  }

  applySettings(settings: GuildSettings): void {
    this.settings = settings;
    this.maxQueueLength = settings.maxQueueLength;
    if (!this.playing) this.volumeValue = settings.defaultVolume;
  }

  setTextChannel(channelId: string | null): void {
    if (this.textChannelId === channelId) return;
    this.textChannelId = channelId;
    this.emitState();
  }

  // --------------------------------------------------------------- connection

  isConnected(): boolean {
    return (
      this.connection !== null &&
      this.connection.state.status !== VoiceConnectionStatus.Destroyed &&
      this.voiceChannelId !== null
    );
  }

  async ensureConnection(channel: { id: string }): Promise<void> {
    if (
      this.voiceChannelId === channel.id &&
      this.connection !== null &&
      this.connection.state.status !== VoiceConnectionStatus.Destroyed &&
      this.connection.state.status !== VoiceConnectionStatus.Disconnected
    ) {
      return;
    }

    if (this.connection !== null || this.voiceChannelId !== null) {
      // Moving channels — or replacing a connection that died — kills the
      // existing stream; start clean instead of pretending the old queue is
      // still playing. This also releases the stream slot it held.
      this.stopInternal();
      this.queue.stop();
      this.clearIdleTimer();
      this.clearDisconnectTimer();
    }

    if (this.connection) {
      const previous = this.connection;
      this.connection = null;
      previous.destroy();
    }
    this.voiceChannelId = null;

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: this.guildId,
      adapterCreator: this.options.adapterCreator,
      selfDeaf: true,
    });

    this.connection = connection;
    this.voiceChannelId = channel.id;
    connection.subscribe(this.audioPlayer);

    connection.on("error", (error) => {
      logger.error("voice connection error", {
        guildId: this.guildId,
        error: error.message,
      });
    });

    connection.on("stateChange", (_oldState, newState) => {
      const action = voiceTransitionAction(newState.status);

      if (action === "teardown") {
        this.clearDisconnectTimer();
        if (this.connection === connection) {
          this.connection = null;
          if (endsSession("destroyed")) void this.endSession();
        }
        return;
      }

      if (action === "schedule-teardown") {
        logger.warn("voice connection disconnected", { guildId: this.guildId });
        this.scheduleDisconnectTeardown(connection);
        return;
      }

      if (action === "cancel-teardown") {
        this.clearDisconnectTimer();
      }
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch {
      connection.destroy();
      this.connection = null;
      this.voiceChannelId = null;
      throw new PlayerError("VOICE_CONNECT_FAILED", "Could not connect to the voice channel.");
    }

    this.beginSession();
    this.emitState();
    this.scheduleIdle();
  }

  // ----------------------------------------------------------------- playback

  /** Start (or reuse) the voice session that scopes the audio cache. */
  beginSession(): string {
    if (!this.sessionId) {
      this.sessionId = randomUUID();
      this.options.downloads.setSession(this.sessionId);
    }
    return this.sessionId;
  }

  /** Snapshot of this guild's downloads for the dashboard. */
  downloadsSnapshot(): DownloadsResponse {
    return this.options.downloads.snapshot();
  }

  /** The single teardown path: it also deletes this session's cached audio. */
  endSession(): Promise<void> {
    return this.serialized(() => this.endSessionInternal());
  }

  enqueue(tracks: QueueTrack[]): Promise<number> {
    return this.serialized(() => this.enqueueInternal(tracks));
  }

  playNext(): Promise<void> {
    return this.serialized(() => this.playNextInternal());
  }

  private async enqueueInternal(tracks: QueueTrack[]): Promise<number> {
    await this.ensureSettings();

    // Cooldown/busy checks run BEFORE the queue is mutated, so a rejected
    // request cannot leave duplicate tracks behind.
    const blocker = startBlocker({
      hasCurrent: this.queue.current !== null,
      paused: this.paused,
      coolingDown: this.isCoolingDown(),
      hasSlot: this.slotLease.holdsSlot || this.semaphore.hasCapacity(),
    });
    if (blocker === "cooldown") {
      throw new PlayerError(
        "COOLDOWN",
        "Playback is cooling down after repeated failures. Try again shortly.",
      );
    }
    if (blocker === "busy") {
      throw new PlayerError(
        "PLAYBACK_BUSY",
        "The bot is already streaming the maximum number of tracks. Try again shortly.",
      );
    }

    const added = this.queue.enqueue(tracks, this.maxQueueLength);
    if (added === 0) return 0;

    this.clearIdleTimer();
    this.emitState();

    // Queueing is all this command does now: playback preparation (download,
    // upload) happens after the reply, so Discord stops showing "thinking".
    if (!this.queue.current && !this.paused) {
      this.scheduleStart(added);
    }

    return added;
  }

  /**
   * Start playback outside the current exclusive section. `setImmediate`
   * defers past the in-flight mutation, then `serialized` keeps the start
   * ordered with every other command. A single flag prevents two concurrent
   * enqueues from starting two streams.
   */
  private scheduleStart(tracks: number): void {
    if (this.isStarting || this.destroyed) return;

    this.isStarting = true;
    logger.debug("enqueue_scheduled", {
      guildId: this.guildId,
      tracks,
      queueLength: this.queue.queue.length,
    });

    setImmediate(() => {
      if (this.destroyed) {
        this.isStarting = false;
        return;
      }

      const run = this.serialized(() => this.playNextInternal()).catch((error: unknown) =>
        this.handleScheduledStartFailure(error),
      );
      void run.finally(() => {
        this.isStarting = false;
      });
    });
  }

  /**
   * A deferred start has no command reply to report into, so failures take the
   * same path as playback failures: one error notice, then the next track.
   */
  private async handleScheduledStartFailure(error: unknown): Promise<void> {
    if (isTransientPlaybackError(error)) {
      // Busy/cooldown is not a failure: the track is already back at the head.
      logger.warn("scheduled playback start deferred", {
        guildId: this.guildId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    try {
      await this.serialized(() => this.handlePlaybackFailure(error, true));
    } catch (handlerError) {
      logger.error("scheduled playback failure handler failed", {
        guildId: this.guildId,
        error: handlerError instanceof Error ? handlerError.message : String(handlerError),
      });
    }
  }

  private async playNextInternal(): Promise<void> {
    if (this.queue.current) {
      await this.startCurrent(0);
      return;
    }

    const next = this.queue.next();
    if (!next) {
      this.handleEmpty();
      return;
    }

    try {
      await this.startCurrent(0);
    } catch (error) {
      this.queue.dropCurrent();
      if (isTransientPlaybackError(error)) {
        // Keep the requested track queued so it can start when a slot frees up.
        this.queue.queue.unshift(next);
      }
      throw error;
    }
  }

  pause(): void {
    if (!this.queue.current) throw new PlayerError("NOTHING_PLAYING", "Nothing is playing.");
    this.audioPlayer.pause();
    if (!this.paused) {
      this.paused = true;
      this.pausedAt = Date.now();
    }
    this.emitState();
  }

  resume(): void {
    if (!this.queue.current) throw new PlayerError("NOTHING_PLAYING", "Nothing is playing.");
    if (!this.paused && this.audioPlayer.state.status !== AudioPlayerStatus.Paused) return;
    this.audioPlayer.unpause();
    if (this.pausedAt !== null) {
      if (this.startedAt !== null) this.startedAt += Date.now() - this.pausedAt;
      this.pausedAt = null;
    }
    this.paused = false;
    this.emitState();
  }

  skip(count = 1): Promise<number> {
    return this.serialized(() => this.skipInternal(count));
  }

  private async skipInternal(count: number): Promise<number> {
    this.stopAudioPlayer();
    this.releaseSlot();
    this.destroyOpened();
    this.playing = false;
    this.releaseCache();

    const removed = this.queue.skip(count);
    this.startedAt = null;
    this.basePositionSec = 0;
    this.paused = false;
    this.pausedAt = null;

    if (this.queue.current) {
      try {
        await this.startCurrent(0);
      } catch (error) {
        if (isTransientPlaybackError(error)) {
          // The next track stays at the head; this is not a playback failure.
          this.emitState();
          throw error;
        }
        await this.handlePlaybackFailure(error, true);
        throw error;
      }
    } else {
      this.scheduleIdle();
    }

    this.emitState();
    return removed.length;
  }

  stop(): Promise<void> {
    return this.serialized(() => this.performStop());
  }

  private async performStop(): Promise<void> {
    // /stop ends the session, which also deletes this session's cached audio.
    await this.endSessionInternal();
  }

  clear(): Promise<number> {
    return this.serialized(() => {
      const cleared = this.queue.clear();
      if (!this.queue.current) this.scheduleIdle();
      this.emitState();
      return cleared;
    });
  }

  seek(positionSec: number): Promise<void> {
    return this.serialized(() => this.seekInternal(positionSec));
  }

  private async seekInternal(positionSec: number): Promise<void> {
    if (!this.queue.current) throw new PlayerError("NOTHING_PLAYING", "Nothing is playing.");
    const target = Math.max(0, Math.floor(positionSec));

    this.stopAudioPlayer();
    this.releaseSlot();
    this.destroyOpened();
    this.playing = false;
    this.paused = false;
    this.pausedAt = null;

    try {
      await this.startCurrent(target, false);
    } catch (error) {
      if (isTransientPlaybackError(error)) {
        // Keep the current track; a busy/cooldown refusal is not a failure.
        this.emitState();
        throw error;
      }
      await this.handlePlaybackFailure(error, true);
      throw error;
    }
  }

  setVolume(volume: number): Promise<number> {
    return this.serialized(() => {
      const clamped = Math.max(0, Math.min(200, Math.round(volume)));
      this.volumeValue = clamped;
      this.resource?.volume?.setVolume(clamped / 100);
      this.emitState();
      return clamped;
    });
  }

  setLoop(mode: LoopMode): Promise<void> {
    return this.serialized(() => {
      this.queue.setLoop(mode);
      this.emitState();
    });
  }

  shuffle(): Promise<void> {
    return this.serialized(() => {
      this.queue.shuffle();
      this.emitState();
    });
  }

  remove(index: number): Promise<QueueTrack> {
    return this.serialized(() => {
      const removed = this.queue.remove(index);
      if (!removed) {
        throw new PlayerError("INVALID_INDEX", "That queue position does not exist.");
      }
      this.emitState();
      return removed;
    });
  }

  move(from: number, to: number): Promise<void> {
    return this.serialized(() => {
      if (!this.queue.move(from, to)) {
        throw new PlayerError("INVALID_INDEX", "Those queue positions do not exist.");
      }
      this.emitState();
    });
  }

  disconnect(): Promise<void> {
    return this.serialized(() => this.performDisconnect());
  }

  private async performDisconnect(): Promise<void> {
    // /disconnect shares the session teardown path with idle and connection loss.
    await this.endSessionInternal();
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    await this.endSession();
  }

  // ------------------------------------------------------------------ state

  getState(): PlayerState {
    return {
      guildId: this.guildId,
      connected: this.isConnected(),
      voiceChannelId: this.voiceChannelId,
      textChannelId: this.textChannelId,
      playing: this.isPlaying(),
      paused: this.paused,
      positionSec: this.positionSeconds(),
      volume: this.volumeValue,
      loop: this.queue.loop,
      current: this.queue.current,
      queue: [...this.queue.queue],
      updatedAt: new Date().toISOString(),
    };
  }

  isCoolingDown(): boolean {
    return Date.now() < this.cooldownUntil;
  }

  getCooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  getFailureCount(): number {
    return this.consecutiveFailures;
  }

  getQueuePosition(): number {
    return this.queue.queue.length;
  }

  // --------------------------------------------------------------- internals

  private isPlaying(): boolean {
    if (!this.playing || this.queue.current === null || this.resource === null || this.paused) {
      return false;
    }
    const status = this.audioPlayer.state.status;
    return status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Buffering;
  }

  private positionSeconds(): number {
    const track = this.queue.current;
    if (!track) return 0;

    let position = this.basePositionSec;
    if (this.paused && this.pausedAt !== null) {
      position += (this.pausedAt - (this.startedAt ?? this.pausedAt)) / 1000;
    } else if (this.startedAt !== null) {
      position += (Date.now() - this.startedAt) / 1000;
    }

    position = Math.max(0, position);
    if (track.durationSec !== null) position = Math.min(position, track.durationSec);
    return Math.round(position * 10) / 10;
  }

  private async startCurrent(startSec: number, record = true): Promise<void> {
    const track = this.queue.current;
    if (!track) {
      this.handleEmpty();
      return;
    }

    const sessionId = this.sessionId ?? this.beginSession();

    // Playback starts immediately: a cached track opens from disk, anything
    // else streams while the cache fills in the background. `prepare()` is
    // only for explicit prefetch and never blocks a start.
    const slot = this.acquireSlot();
    if (slot === null) {
      throw new PlayerError(
        "PLAYBACK_BUSY",
        "The bot is already streaming the maximum number of tracks. Try again shortly.",
      );
    }

    let opened: OpenedStream;
    try {
      opened = await this.options.media.open(track, {
        startSec,
        sessionId,
        downloads: this.options.downloads,
      });
    } catch (error) {
      this.releaseSlot(slot);
      throw error;
    }

    // A cache hit carries the download's authoritative metadata; update the
    // queued track before the now-playing embed reads it.
    if (this.options.media.preparedInfo) {
      enrichTrack(track, this.options.media.preparedInfo(track, sessionId));
    }

    if (this.destroyed || this.queue.current !== track) {
      opened.stop();
      // Release only our own generation: a newer stream may already hold the
      // slot, and a late release must not free it.
      this.releaseSlot(slot);
      return;
    }

    this.opened = opened;
    const resource = createAudioResource(opened.stream, {
      inlineVolume: true,
      inputType: StreamType.Raw,
    });
    resource.volume?.setVolume(this.volumeValue / 100);
    this.resource = resource;

    try {
      this.connection?.subscribe(this.audioPlayer);
      this.audioPlayer.play(resource);
    } catch (error) {
      this.destroyOpened();
      this.releaseSlot(slot);
      throw error;
    }

    this.startedAt = Date.now();
    this.basePositionSec = startSec;
    this.paused = false;
    this.pausedAt = null;
    this.playing = true;
    this.emitState();
    this.scheduleIdle();

    this.activateCache(sessionId, track);

    if (record && this.options.recordPlay) {
      void this.options.recordPlay(track).catch((error: unknown) => {
        logger.warn("failed to record play history", {
          guildId: this.guildId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private onPlayerStateChange(
    previous: AudioPlayerStatus,
    next: AudioPlayerStatus,
    previousResource: AudioResource | null,
  ): void {
    if (next === AudioPlayerStatus.Idle && previous !== AudioPlayerStatus.Idle) {
      if (this.handlingFailure) return;
      if (isSuppressedIdle(previousResource, this.expectedStopResource)) {
        // This Idle was caused by our own stop; it is not the end of a track.
        this.expectedStopResource = null;
        return;
      }
      if (!this.queue.current) return;
      void this.serialized(() => this.advanceAfterEnd()).catch((error: unknown) => {
        void this.serialized(() => this.handlePlaybackFailure(error, true));
      });
      return;
    }

    if (next === AudioPlayerStatus.Paused && !this.paused) {
      this.paused = true;
      this.pausedAt = Date.now();
      this.emitState();
    } else if (next === AudioPlayerStatus.Playing && this.paused) {
      this.paused = false;
      this.emitState();
    }
  }

  private async advanceAfterEnd(): Promise<void> {
    this.releaseSlot();
    this.destroyOpened();
    this.playing = false;
    this.startedAt = null;
    this.basePositionSec = 0;

    const previous = this.queue.current;
    const action = this.queue.onTrackEnd();

    if (action.type === "replay") {
      // loop=track: the same track replays, so this is not a new play.
      await this.startCurrent(0, false);
      return;
    }

    if (action.type === "play") {
      const recorded = isRealAdvance(previous?.id ?? null, action.track.id);
      await this.startCurrent(0, recorded);
      return;
    }

    this.scheduleIdle();
    this.emitState();
  }

  private async handlePlaybackFailure(error: unknown, notify: boolean): Promise<void> {
    if (this.handlingFailure) return;
    this.handlingFailure = true;
    const messages: string[] = [];
    let tripped = false;

    try {
      let currentError = error;

      for (;;) {
        this.releaseSlot();
        this.destroyOpened();
        this.playing = false;
        this.startedAt = null;
        this.basePositionSec = 0;
        this.paused = false;
        this.pausedAt = null;

        const message = currentError instanceof Error ? currentError.message : String(currentError);
        const stderr =
          currentError instanceof MediaError
            ? sanitizeProcessOutput(currentError.stderr)
            : undefined;
        logger.error("playback failure", {
          guildId: this.guildId,
          error: message,
          ...(stderr ? { stderr } : {}),
        });
        messages.push(message);

        tripped = this.registerFailure();

        this.queue.dropCurrent();

        if (tripped || this.queue.queue.length === 0 || this.destroyed) {
          this.scheduleIdle();
          this.emitState();
          return;
        }

        try {
          await this.startCurrent(0);
          this.emitState();
          return;
        } catch (nextError) {
          currentError = nextError;
        }
      }
    } finally {
      this.handlingFailure = false;
      if (notify) {
        // One embed per failure burst, however many retries failed.
        const notice = failureNotice(messages, tripped);
        if (notice) this.notifyError(notice);
      }
    }
  }

  private registerFailure(): boolean {
    const now = Date.now();
    this.failureTimes = this.failureTimes.filter((time) => now - time < FAILURE_WINDOW_MS);
    this.failureTimes.push(now);
    this.consecutiveFailures = this.failureTimes.length;

    if (this.failureTimes.length >= FAILURE_THRESHOLD) {
      this.failureTimes = [];
      this.consecutiveFailures = 0;
      this.cooldownUntil = now + COOLDOWN_MS;
      return true;
    }
    return false;
  }

  private acquireSlot(): number | null {
    return this.slotLease.acquire();
  }

  private releaseSlot(generation: number | null = this.slotLease.current): void {
    this.slotLease.release(generation);
  }

  private destroyOpened(): void {
    if (this.opened) {
      try {
        this.opened.stop();
      } catch {
        // Already stopped.
      }
      this.opened = null;
    }
    if (this.resource) {
      try {
        this.resource.playStream.destroy();
      } catch {
        // Already destroyed.
      }
      this.resource = null;
    }
  }

  /** Stop the audio player on purpose, remembering which resource we silenced. */
  private stopAudioPlayer(): void {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Idle) return;
    this.expectedStopResource = this.resource;
    this.audioPlayer.stop(true);
  }

  private serialized<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private stopInternal(): void {
    this.releaseSlot();
    this.destroyOpened();
    this.releaseCache();
    this.playing = false;
    this.paused = false;
    this.pausedAt = null;
    this.startedAt = null;
    this.basePositionSec = 0;
  }

  /**
   * The single session teardown path: stop playback, clear the queue, release
   * cached audio and leave the channel. `stopInternal` never does this — a
   * channel move keeps the session.
   */
  private async endSessionInternal(): Promise<void> {
    const sessionId = this.sessionId;

    this.clearIdleTimer();
    this.clearDisconnectTimer();
    this.stopAudioPlayer();
    this.stopInternal();
    this.queue.stop();
    this.sessionId = null;
    this.options.downloads.clear();

    const connection = this.connection;
    this.connection = null;
    connection?.destroy();

    this.voiceChannelId = null;
    this.textChannelId = null;
    this.nowPlayingMessageId = null;

    if (sessionId && this.options.media.releaseSession) {
      try {
        await this.options.media.releaseSession(sessionId);
      } catch (error) {
        logger.warn("failed to release audio cache session", {
          guildId: this.guildId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.emitState();
  }

  /** Pin the new current track, unpin the previous one, prefetch the next. */
  private activateCache(sessionId: string, track: QueueTrack): void {
    const previous = this.pinnedTrackId;
    this.pinnedTrackId = track.id;

    void this.options.media
      .pin?.(sessionId, track.id)
      .catch((error: unknown) =>
        logger.debug("failed to pin cached track", { error: String(error) }),
      );

    if (previous && previous !== track.id) {
      void this.options.media
        .unpin?.(sessionId, previous)
        .catch((error: unknown) =>
          logger.debug("failed to unpin cached track", { error: String(error) }),
        );
    }

    const next = this.queue.queue[0];
    if (next) {
      // Fire-and-forget: a failed prefetch never delays the command response.
      void this.options.media
        .prefetch?.(next, sessionId, this.options.downloads)
        .catch((error: unknown) =>
          logger.warn("prefetch failed", {
            guildId: this.guildId,
            trackId: next.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    }
  }

  /** Cancel background work and drop pins; cached files are deleted by endSession. */
  private releaseCache(): void {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    const previous = this.pinnedTrackId;
    this.pinnedTrackId = null;

    this.options.media.cancelPrefetch?.(sessionId);
    if (previous) {
      void this.options.media
        .unpin?.(sessionId, previous)
        .catch((error: unknown) =>
          logger.debug("failed to unpin cached track", { error: String(error) }),
        );
    }
  }

  private scheduleDisconnectTeardown(connection: VoiceConnection): void {
    this.clearDisconnectTimer();
    const timer = setTimeout(() => {
      this.disconnectTimer = null;
      if (this.connection !== connection) return;
      if (connection.state.status === VoiceConnectionStatus.Ready) return;
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
      }
      if (this.connection !== connection) return;
      this.connection = null;
      void this.endSession();
    }, VOICE_DISCONNECT_GRACE_MS);
    timer.unref?.();
    this.disconnectTimer = timer;
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  private handleEmpty(): void {
    this.playing = false;
    this.startedAt = null;
    this.basePositionSec = 0;
    this.scheduleIdle();
    this.emitState();
  }

  private scheduleIdle(): void {
    this.clearIdleTimer();
    if (!this.connection) return;
    if (this.idleTimeoutSeconds <= 0) return;
    this.idleTimer = setTimeout(() => {
      void this.checkIdle();
    }, this.idleTimeoutSeconds * 1000);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async checkIdle(): Promise<void> {
    this.idleTimer = null;
    if (!this.connection) return;

    const emptyQueue = this.queue.current === null && this.queue.queue.length === 0;
    let humanCount: number | null = null;

    if (this.voiceChannelId && this.options.getHumanMemberCount) {
      try {
        humanCount = await this.options.getHumanMemberCount(this.voiceChannelId);
      } catch (error) {
        // Unknown member count must never be mistaken for an empty channel.
        humanCount = null;
        logger.warn("failed to inspect voice channel members", {
          guildId: this.guildId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (shouldIdleDisconnect(emptyQueue, humanCount)) {
      if (endsSession("idle")) await this.endSession();
      return;
    }

    this.scheduleIdle();
  }

  private emitState(): void {
    try {
      this.options.onStateChange?.(this.getState());
    } catch (error) {
      logger.warn("state listener failed", {
        guildId: this.guildId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private notifyError(message: string): void {
    try {
      this.options.onError?.(message);
    } catch (error) {
      logger.warn("error listener failed", {
        guildId: this.guildId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
