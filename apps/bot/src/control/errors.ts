import { MediaError, PlayerError } from "../errors.js";

export interface ControlErrorResult {
  status: number;
  body: { ok: false; error: { code: string; message: string } };
}

export function mapControlError(error: unknown): ControlErrorResult {
  if (error instanceof PlayerError) {
    const body = {
      ok: false as const,
      error: { code: error.code, message: error.message },
    };

    switch (error.code) {
      case "PLAYBACK_BUSY":
      case "COOLDOWN":
      case "NOT_CONNECTED":
        return { status: 409, body };
      case "GUILD_NOT_FOUND":
      case "PLAYLIST_NOT_FOUND":
        return { status: 404, body };
      default:
        return { status: 400, body };
    }
  }

  if (error instanceof MediaError) {
    return {
      status: 400,
      body: { ok: false, error: { code: error.code, message: error.message } },
    };
  }

  return {
    status: 500,
    body: {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Unexpected server error." },
    },
  };
}
