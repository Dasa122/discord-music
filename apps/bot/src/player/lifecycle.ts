import { VoiceConnectionStatus } from "@discordjs/voice";

/** Settings loaded from Postgres are re-read at most this often, so dashboard edits apply live. */
export const SETTINGS_TTL_MS = 30_000;

/** How long a disconnected voice connection may try to resume before we tear it down. */
export const VOICE_DISCONNECT_GRACE_MS = 15_000;

/** A voice session with nothing to play ends after this long. */
export const SESSION_IDLE_TIMEOUT_SECONDS = 60;

/**
 * A voice session is not a cache library: it starts on join and ends on every
 * teardown path. A channel move keeps the same session.
 */
export type SessionEndReason = "stop" | "disconnect" | "destroyed" | "idle" | "shutdown" | "move";

export function endsSession(reason: SessionEndReason): boolean {
  return reason !== "move";
}

/** A human in the channel with music queued cancels the idle countdown. */
export function shouldCancelIdle(emptyQueue: boolean, humanCount: number | null): boolean {
  return !emptyQueue && humanCount !== null && humanCount > 0;
}

export type VoiceTransitionAction = "teardown" | "schedule-teardown" | "cancel-teardown" | "none";

/** Pure mapping from a voice connection status to the lifecycle work it requires. */
export function voiceTransitionAction(status: VoiceConnectionStatus): VoiceTransitionAction {
  if (status === VoiceConnectionStatus.Destroyed) return "teardown";
  if (status === VoiceConnectionStatus.Disconnected) return "schedule-teardown";
  if (status === VoiceConnectionStatus.Ready) return "cancel-teardown";
  return "none";
}

export function isSettingsStale(
  loadedAt: number | null,
  now: number,
  ttlMs = SETTINGS_TTL_MS,
): boolean {
  return loadedAt === null || now - loadedAt >= ttlMs;
}

/**
 * Idle disconnection decision. A `null` human count means "unknown" (channel
 * fetch failed) and must reschedule instead of pretending the channel is empty.
 */
export function shouldIdleDisconnect(emptyQueue: boolean, humanCount: number | null): boolean {
  if (emptyQueue) return true;
  return humanCount === 0;
}

export type StartBlocker = "cooldown" | "busy" | null;

/** Pre-flight check used before a request is allowed to mutate the queue. */
export function startBlocker(input: {
  hasCurrent: boolean;
  paused: boolean;
  coolingDown: boolean;
  hasSlot: boolean;
}): StartBlocker {
  if (input.hasCurrent || input.paused) return null;
  if (input.coolingDown) return "cooldown";
  if (!input.hasSlot) return "busy";
  return null;
}

/** At most one error embed per failure burst, even when the retry loop fails repeatedly. */
export function failureNotice(messages: string[], tripped: boolean): string | null {
  const first = messages[0];
  if (!first) return null;
  return tripped ? `Playback stopped after repeated failures: ${first}` : first;
}

/**
 * An Idle event is only ours to swallow when it came from the exact resource
 * we stopped on purpose. Anything else is a genuine end and must advance.
 */
export function isSuppressedIdle<T>(previousResource: T | null, expectedStop: T | null): boolean {
  return previousResource !== null && previousResource === expectedStop;
}
