export type MediaErrorCode = "EXTRACTOR_FAILED" | "NOT_FOUND" | "SPAWN_FAILED";

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
