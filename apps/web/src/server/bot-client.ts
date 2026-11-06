import type { ControlAction, ControlResponse, GuildSummary, PlayerState } from "@music/shared";
import { config } from "./config.js";

/**
 * Typed client for the bot's internal control API.
 *
 * Every call carries `x-control-secret` and is bounded by a 5 second timeout so
 * a hung bot cannot pin web requests. Failures are returned as values, never
 * thrown, because every route has to decide its own HTTP status.
 */

export type BotError = { code: string; message: string };
export type BotResult<T> = { ok: true; data: T } | { ok: false; error: BotError };

const REQUEST_TIMEOUT_MS = 5_000;

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
export function botErrorStatus(code: string): 400 | 502 | 503 | 504 {
  switch (code) {
    case "BOT_TIMEOUT":
      return 504;
    case "BOT_UNAVAILABLE":
      return 503;
    case "BOT_ERROR":
      return 502;
    default:
      return 400;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<BotResult<T>> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("x-control-secret", config.botControlSecret);

  let response: Response;
  try {
    response = await fetch(`${config.botInternalUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    return request<PlayerState>(`/guilds/${encodeURIComponent(guildId)}/state`);
  },

  async action(guildId: string, action: ControlAction): Promise<BotResult<PlayerState>> {
    const result = await request<ControlResponse>(
      `/guilds/${encodeURIComponent(guildId)}/actions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action),
      },
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
