import type {
  ControlAction,
  ControlResponse,
  DownloadsResponse,
  GuildSummary,
  PlayerState,
} from "@music/shared";
import { downloadsResponseSchema } from "@music/shared";
import { config } from "./config.js";

/**
 * Typed client for the bot's internal control API.
 *
 * Every call carries `x-control-secret`. Read-only calls are bounded by a 5
 * second timeout; playback actions get 90 seconds because yt-dlp resolution
 * and prebuffering can legitimately take that long. Failures are returned as
 * values, never thrown, because every route has to decide its own HTTP status.
 */

export type BotError = { code: string; message: string };
export type BotResult<T> = { ok: true; data: T } | { ok: false; error: BotError };

export const BOT_TIMEOUTS = {
  state: 5_000,
  downloads: 5_000,
  health: 5_000,
  action: 90_000,
} as const;

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

export function errorFromFetchFailure(error: unknown): BotError {
  if (isTimeoutError(error)) {
    return { code: "BOT_TIMEOUT", message: "The bot did not respond in time" };
  }
  return { code: "BOT_UNAVAILABLE", message: "The bot is unreachable" };
}

export function isBotErrorShape(value: unknown): value is BotError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

export function errorFromHttpResponse(status: number, body: unknown): BotError {
  if (typeof body === "object" && body !== null) {
    const envelope = body as { error?: unknown };
    if (isBotErrorShape(envelope.error)) return envelope.error;
  }
  return { code: "BOT_ERROR", message: `The bot responded with HTTP ${status}` };
}

/** HTTP status the web API should answer with for a bot-side failure. */
export function botErrorStatus(code: string): 400 | 404 | 409 | 502 | 503 | 504 {
  switch (code) {
    case "BOT_TIMEOUT":
      return 504;
    case "BOT_UNAVAILABLE":
      return 503;
    case "GUILD_NOT_FOUND":
    case "PLAYLIST_NOT_FOUND":
      return 404;
    case "PLAYBACK_BUSY":
    case "NOT_CONNECTED":
    case "COOLDOWN":
      return 409;
    case "VALIDATION":
    case "MEDIA_ERROR":
    case "EXTRACTOR_FAILED":
    case "NOT_FOUND":
    case "SPAWN_FAILED":
    case "INVALID_URL":
    case "INVALID_INDEX":
    case "NOTHING_PLAYING":
      return 400;
    default:
      return 502;
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs: number = BOT_TIMEOUTS.state,
): Promise<BotResult<T>> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("x-control-secret", config.botControlSecret);

  let response: Response;
  try {
    response = await fetch(`${config.botInternalUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, error: errorFromFetchFailure(error) };
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, error: errorFromHttpResponse(response.status, body) };
  }
  if (body === null) {
    return {
      ok: false,
      error: { code: "BOT_ERROR", message: "The bot returned a non-JSON response" },
    };
  }
  return { ok: true, data: body as T };
}

export const botClient = {
  /**
   * Liveness only: a 2xx is healthy even if the body is not JSON, so this does
   * not go through `request` (which requires a JSON body).
   */
  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${config.botInternalUrl}/health`, {
        headers: { "x-control-secret": config.botControlSecret },
        signal: AbortSignal.timeout(BOT_TIMEOUTS.health),
      });
      return response.ok;
    } catch {
      return false;
    }
  },

  async guilds(): Promise<BotResult<GuildSummary[]>> {
    const result = await request<{ guilds?: GuildSummary[] }>("/guilds");
    if (!result.ok) return result;
    if (!Array.isArray(result.data.guilds)) {
      return {
        ok: false,
        error: { code: "BOT_ERROR", message: "The bot returned an invalid guild list" },
      };
    }
    return { ok: true, data: result.data.guilds };
  },

  async state(guildId: string): Promise<BotResult<PlayerState>> {
    return request<PlayerState>(
      `/guilds/${encodeURIComponent(guildId)}/state`,
      {},
      BOT_TIMEOUTS.state,
    );
  },

  async downloads(guildId: string): Promise<BotResult<DownloadsResponse>> {
    const result = await request<unknown>(
      `/guilds/${encodeURIComponent(guildId)}/downloads`,
      {},
      BOT_TIMEOUTS.downloads,
    );
    if (!result.ok) return result;

    const parsed = downloadsResponseSchema.safeParse(result.data);
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: "BOT_ERROR", message: "The bot returned invalid download data" },
      };
    }
    return { ok: true, data: parsed.data };
  },

  async action(guildId: string, action: ControlAction): Promise<BotResult<PlayerState>> {
    const result = await request<ControlResponse>(
      `/guilds/${encodeURIComponent(guildId)}/actions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action),
      },
      BOT_TIMEOUTS.action,
    );
    if (!result.ok) return result;

    const payload = result.data;
    if (payload.ok === true) return { ok: true, data: payload.data };
    if (isBotErrorShape(payload.error)) return { ok: false, error: payload.error };
    return {
      ok: false,
      error: { code: "BOT_ERROR", message: "The bot returned an unexpected response" },
    };
  },
};
