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
import { MediaError, PlayerError } from "../errors.js";
import { logger } from "../logger.js";
import type { MediaEngine, OpenedStream } from "../media/media-engine.js";
import { QueueController } from "./queue-ops.js";

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

  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.trunc(limit));
  }

  get inUse(): number {
    return this.active;
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
  adapterCreator: DiscordGatewayAdapterCreator;
  loadSettings?: () => Promise<GuildSettings>;
  recordPlay?: (track: QueueTrack) => Promise<void>;
  getHumanMemberCount?: (channelId: string) => Promise<number>;
  onStateChange?: (state: PlayerState) => void;
  onError?: (message: string) => void;
  idleTimeoutSeconds?: number;
  semaphore?: StreamSemaphore;
  rng?: () => number;
}

const DEFAULT_SETTINGS_VOLUME = 100;
const DEFAULT_MAX_QUEUE_LENGTH = 100;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 300;
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
  private readonly idleTimeoutSeconds: number;

  private settings: GuildSettings;
  private settingsPromise: Promise<void> | null = null;
  private opened: OpenedStream | null = null;
  private resource: AudioResource | null = null;
  private playing = false;
  private paused = false;
  private startedAt: number | null = null;
  private basePositionSec = 0;
  private pausedAt: number | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private suppressIdleUntil = 0;
  private failureTimes: number[] = [];
  private consecutiveFailures = 0;
  private cooldownUntil = 0;
  private holdsSlot = false;
  private handlingFailure = false;
  private destroyed = false;
  private volumeValue = DEFAULT_SETTINGS_VOLUME;
  private maxQueueLength = DEFAULT_MAX_QUEUE_LENGTH;

  constructor(options: GuildPlayerOptions) {
    this.options = options;
    this.guildId = options.guildId;
    this.queue = new QueueController(options.rng);
    this.semaphore = options.semaphore ?? globalStreamSemaphore;
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
      this.onPlayerStateChange(oldState.status, newState.status);
    });
    this.audioPlayer.on("error", (error) => {
      if (!this.queue.current || this.destroyed) return;
      void this.handlePlaybackFailure(error, true);
    });
  }

  // ---------------------------------------------------------------- settings

  getSettings(): GuildSettings {
    return this.settings;
  }

  async ensureSettings(): Promise<void> {
    if (this.settingsPromise) return this.settingsPromise;
    if (!this.options.loadSettings) return;
    this.settingsPromise = this.options
      .loadSettings()
      .then((settings) => {
        this.settings = settings;
        this.volumeValue = settings.defaultVolume;
        this.maxQueueLength = settings.maxQueueLength;
      })
      .catch((error: unknown) => {
        logger.warn("failed to load guild settings; using defaults", {
          guildId: this.guildId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return this.settingsPromise;
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

    if (this.voiceChannelId !== null && this.voiceChannelId !== channel.id) {
      // Moving channels kills the existing stream; start clean instead of
      // pretending the old queue is still playing.
      this.stopInternal();
      this.queue.stop();
    }

    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }

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
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        logger.warn("voice connection disconnected", { guildId: this.guildId });
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

    this.emitState();
    this.scheduleIdle();
  }

  // ----------------------------------------------------------------- playback

  async enqueue(tracks: QueueTrack[]): Promise<number> {
    await this.ensureSettings();
    const added = this.queue.enqueue(tracks, this.maxQueueLength);
    if (added === 0) return 0;

    this.emitState();

    if (!this.queue.current && !this.paused) {
      if (this.isCoolingDown()) {
        throw new PlayerError(
          "COOLDOWN",
          "Playback is cooling down after repeated failures. Try again shortly.",
        );
      }
      try {
        await this.playNext();
      } catch (error) {
        if (!(error instanceof PlayerError)) this.registerFailure();
        throw error;
      }
    }

    return added;
  }

  async playNext(): Promise<void> {
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
      if (
        error instanceof PlayerError &&
        (error.code === "PLAYBACK_BUSY" || error.code === "COOLDOWN")
      ) {
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

  async skip(count = 1): Promise<number> {
    this.suppressIdleUntil = Date.now() + 750;
    if (this.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
      this.audioPlayer.stop(true);
    }
    this.releaseSlot();
    this.destroyOpened();
    this.playing = false;

    const removed = this.queue.skip(count);
    this.startedAt = null;
    this.basePositionSec = 0;
    this.paused = false;
    this.pausedAt = null;

    if (this.queue.current) {
      try {
        await this.startCurrent(0);
      } catch (error) {
        await this.handlePlaybackFailure(error, true);
      }
    } else {
      this.scheduleIdle();
    }

    this.emitState();
    return removed.length;
  }

  async stop(): Promise<void> {
    this.suppressIdleUntil = Date.now() + 750;
    if (this.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
      this.audioPlayer.stop(true);
    }
    this.stopInternal();
    this.queue.stop();
    this.paused = false;
    this.pausedAt = null;
    this.scheduleIdle();
    this.emitState();
  }

  clear(): number {
    const cleared = this.queue.clear();
    if (!this.queue.current) this.scheduleIdle();
    this.emitState();
    return cleared;
  }

  async seek(positionSec: number): Promise<void> {
    if (!this.queue.current) throw new PlayerError("NOTHING_PLAYING", "Nothing is playing.");
    const target = Math.max(0, Math.floor(positionSec));

    this.suppressIdleUntil = Date.now() + 750;
    if (this.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
      this.audioPlayer.stop(true);
    }
    this.releaseSlot();
    this.destroyOpened();
    this.playing = false;
    this.paused = false;
    this.pausedAt = null;

    try {
      await this.startCurrent(target, false);
    } catch (error) {
      await this.handlePlaybackFailure(error, true);
      throw error;
    }
  }

  setVolume(volume: number): number {
    const clamped = Math.max(0, Math.min(200, Math.round(volume)));
    this.volumeValue = clamped;
    this.resource?.volume?.setVolume(clamped / 100);
    this.emitState();
    return clamped;
  }

  setLoop(mode: LoopMode): void {
    this.queue.setLoop(mode);
    this.emitState();
  }

  shuffle(): void {
    this.queue.shuffle();
    this.emitState();
  }

  remove(index: number): QueueTrack {
    const removed = this.queue.remove(index);
    if (!removed) {
      throw new PlayerError("INVALID_INDEX", "That queue position does not exist.");
    }
    this.emitState();
    return removed;
  }

  move(from: number, to: number): void {
    if (!this.queue.move(from, to)) {
      throw new PlayerError("INVALID_INDEX", "Those queue positions do not exist.");
    }
    this.emitState();
  }

  async disconnect(): Promise<void> {
    this.suppressIdleUntil = Date.now() + 750;
    if (this.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
      this.audioPlayer.stop(true);
    }
    this.stopInternal();
    this.queue.stop();
    this.paused = false;
    this.pausedAt = null;
    this.clearIdleTimer();
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
    this.voiceChannelId = null;
    this.textChannelId = null;
    this.emitState();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopInternal();
    this.queue.stop();
    this.clearIdleTimer();
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
    this.voiceChannelId = null;
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

    if (!this.acquireSlot()) {
      throw new PlayerError(
        "PLAYBACK_BUSY",
        "The bot is already streaming the maximum number of tracks. Try again shortly.",
      );
    }

    let opened: OpenedStream;
    try {
      opened = await this.options.media.open(track, { startSec });
    } catch (error) {
      this.releaseSlot();
      throw error;
    }

    if (this.destroyed || this.queue.current !== track) {
      opened.stop();
      this.releaseSlot();
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
      this.releaseSlot();
      throw error;
    }

    this.startedAt = Date.now();
    this.basePositionSec = startSec;
    this.paused = false;
    this.pausedAt = null;
    this.playing = true;
    this.emitState();

    if (record && this.options.recordPlay) {
      void this.options.recordPlay(track).catch((error: unknown) => {
        logger.warn("failed to record play history", {
          guildId: this.guildId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private onPlayerStateChange(previous: AudioPlayerStatus, next: AudioPlayerStatus): void {
    if (next === AudioPlayerStatus.Idle && previous !== AudioPlayerStatus.Idle) {
      if (Date.now() < this.suppressIdleUntil) {
        this.suppressIdleUntil = 0;
        return;
      }
      if (!this.queue.current) return;
      void this.advanceAfterEnd().catch((error: unknown) => {
        void this.handlePlaybackFailure(error, true);
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

    const action = this.queue.onTrackEnd();
    if (action.type === "replay" || action.type === "play") {
      await this.startCurrent(0);
      return;
    }

    this.scheduleIdle();
    this.emitState();
  }

  private async handlePlaybackFailure(error: unknown, notify: boolean): Promise<void> {
    if (this.handlingFailure) return;
    this.handlingFailure = true;
    this.suppressIdleUntil = Date.now() + 1500;

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
        logger.error("playback failure", {
          guildId: this.guildId,
          error: message,
          stderr: currentError instanceof MediaError ? currentError.stderr : undefined,
        });

        const tripped = this.registerFailure();
        if (notify) {
          this.notifyError(
            tripped ? `Playback stopped after repeated failures: ${message}` : message,
          );
        }

        this.queue.dropCurrent();

        if (tripped || this.queue.queue.length === 0 || this.destroyed) {
          this.scheduleIdle();
          this.emitState();
          return;
        }

        try {
          await this.startCurrent(0);
          return;
        } catch (nextError) {
          currentError = nextError;
        }
      }
    } finally {
      this.handlingFailure = false;
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

  private acquireSlot(): boolean {
    if (this.holdsSlot) return true;
    if (!this.semaphore.tryAcquire()) return false;
    this.holdsSlot = true;
    return true;
  }

  private releaseSlot(): void {
    if (!this.holdsSlot) return;
    this.holdsSlot = false;
    this.semaphore.release();
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

  private stopInternal(): void {
    this.releaseSlot();
    this.destroyOpened();
    this.playing = false;
    this.startedAt = null;
    this.basePositionSec = 0;
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
    let noHumans = false;

    if (this.voiceChannelId && this.options.getHumanMemberCount) {
      try {
        noHumans = (await this.options.getHumanMemberCount(this.voiceChannelId)) === 0;
      } catch (error) {
        logger.warn("failed to inspect voice channel members", {
          guildId: this.guildId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (emptyQueue || noHumans) {
      await this.disconnect();
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
