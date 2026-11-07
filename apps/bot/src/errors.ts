export type MediaErrorCode =
  | "EXTRACTOR_FAILED"
  | "NOT_FOUND"
  | "SPAWN_FAILED"
  | "INVALID_URL"
  | "EXTRACTION_BUSY"
  | "OUTPUT_TOO_LARGE"
  | "DOWNLOAD_FAILED"
  | "DOWNLOAD_TOO_LARGE"
  | "DOWNLOAD_ABORTED";

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  readonly stderr: string | undefined;

  constructor(code: MediaErrorCode, message: string, stderr?: string) {
    super(message);
    this.name = "MediaError";
    this.code = code;
    this.stderr = stderr;
  }
}

export type PlayerErrorCode =
  | "PLAYBACK_BUSY"
  | "NOT_CONNECTED"
  | "NOTHING_PLAYING"
  | "INVALID_INDEX"
  | "GUILD_NOT_FOUND"
  | "PLAYLIST_NOT_FOUND"
  | "COOLDOWN"
  | "VOICE_CONNECT_FAILED";

export class PlayerError extends Error {
  readonly code: PlayerErrorCode;

  constructor(code: PlayerErrorCode, message: string) {
    super(message);
    this.name = "PlayerError";
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}

export function isTransientPlaybackError(error: unknown): boolean {
  return (
    error instanceof PlayerError && (error.code === "PLAYBACK_BUSY" || error.code === "COOLDOWN")
  );
}

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

/**
 * Errors shown in Discord must never leak raw Postgres/driver or unexpected
 * internal text. Only our own typed errors carry a message intended for users.
 */
export function userFacingErrorMessage(error: unknown): string {
  if (error instanceof PlayerError || error instanceof MediaError) return error.message;
  return GENERIC_ERROR_MESSAGE;
}
