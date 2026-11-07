import type {
  DownloadsResponse,
  GuildSettings,
  GuildSettingsUpdate,
  GuildSummary,
  LoopMode,
  PlayerState,
  Playlist,
} from "@music/shared";

/** Session identity returned by `GET /api/me`. */
export type Me = {
  sub: string;
  name: string;
  groups: string[];
};

/** Playlist row as listed by `GET /api/guilds/:guildId/playlists`. */
export type PlaylistSummary = Playlist & {
  itemCount: number;
};

/** Playlist item shape used by the playlist detail view. */
export type PlaylistItemView = {
  id: string;
  title: string;
  url: string;
  durationSec: number | null;
  thumbnailUrl: string | null;
  addedBy: string;
  position: number;
};

/** Playlist with its ordered items. */
export type PlaylistDetail = Playlist & {
  items: PlaylistItemView[];
};

/** One row of `GET /api/guilds/:guildId/history`. */
export type HistoryItem = {
  id: string;
  title: string;
  url: string;
  durationSec: number | null;
  requestedBy: string;
  playedAt: string;
};

export type HistoryPage = {
  items: HistoryItem[];
  total: number;
};

/**
 * Body of `POST /api/guilds/:guildId/actions`.
 *
 * The server fills `requestedBy` from the authenticated session, so the UI
 * only sends what the user actually chose.
 */
export type GuildActionBody =
  | { type: "play"; query: string }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "skip"; count?: number }
  | { type: "stop" }
  | { type: "seek"; positionSec: number }
  | { type: "volume"; volume: number }
  | { type: "loop"; mode: LoopMode }
  | { type: "shuffle" }
  | { type: "remove"; index: number }
  | { type: "move"; from: number; to: number }
  | { type: "clear" }
  | { type: "disconnect" }
  | { type: "playPlaylist"; playlistId: string };

type ApiErrorPayload = {
  code: string;
  message: string;
};

type Envelope<T> = { success: true; data: T } | { success: false; error: ApiErrorPayload };

const STATUS_FALLBACKS: Record<number, ApiErrorPayload> = {
  401: {
    code: "unauthorized",
    message: "Your session expired. Sign in again to keep controlling the bot.",
  },
  403: {
    code: "forbidden",
    message: "Your account is not allowed to use this dashboard.",
  },
  404: { code: "not_found", message: "The requested resource could not be found." },
  500: { code: "server_error", message: "The server hit an unexpected error. Try again." },
};

/** Error thrown by the fetch helpers, carrying the envelope code and HTTP status. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEnvelope<T>(value: unknown): value is Envelope<T> {
  if (!isRecord(value) || typeof value.success !== "boolean") {
    return false;
  }
  if (value.success) {
    return "data" in value;
  }
  return (
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  );
}

function extractError(payload: unknown, status: number): ApiErrorPayload {
  if (
    isRecord(payload) &&
    payload.success === false &&
    isRecord(payload.error) &&
    typeof payload.error.code === "string" &&
    typeof payload.error.message === "string"
  ) {
    return { code: payload.error.code, message: payload.error.message };
  }

  return (
    STATUS_FALLBACKS[status] ?? {
      code: "request_failed",
      message: `The request failed (HTTP ${status}).`,
    }
  );
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      "network_error",
      "Could not reach the server. Check your connection and try again.",
      0,
    );
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error = extractError(payload, response.status);
    throw new ApiError(error.code, error.message, response.status);
  }

  if (!isEnvelope<T>(payload)) {
    throw new ApiError(
      "invalid_response",
      "The server returned an unexpected response.",
      response.status,
    );
  }

  if (!payload.success) {
    throw new ApiError(payload.error.code, payload.error.message, response.status);
  }

  return payload.data;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>("GET", path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("POST", path, body);
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("PUT", path, body);
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("PATCH", path, body);
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>("DELETE", path);
}

/** Reads a human-readable message out of anything thrown by the client. */
export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "Something went wrong. Try again.";
}

export const queryKeys = {
  me: () => ["me"] as const,
  guilds: () => ["guilds"] as const,
  state: (guildId: string | null) => ["guilds", guildId, "state"] as const,
  downloads: (guildId: string | null) => ["guilds", guildId, "downloads"] as const,
  settings: (guildId: string | null) => ["guilds", guildId, "settings"] as const,
  playlists: (guildId: string | null) => ["guilds", guildId, "playlists"] as const,
  playlist: (playlistId: string | null) => ["playlists", playlistId] as const,
  history: (guildId: string | null, page: number) => ["guilds", guildId, "history", page] as const,
};

const guildPath = (guildId: string) => `/api/guilds/${encodeURIComponent(guildId)}`;
const playlistPath = (playlistId: string) => `/api/playlists/${encodeURIComponent(playlistId)}`;
const withGuildQuery = (path: string, guildId: string) =>
  `${path}?guildId=${encodeURIComponent(guildId)}`;

/** Typed bindings for every endpoint the dashboard uses. */
export const api = {
  me: () => apiGet<Me>("/api/me"),
  guilds: () => apiGet<GuildSummary[]>("/api/guilds"),
  state: (guildId: string) => apiGet<PlayerState>(`${guildPath(guildId)}/state`),
  downloads: (guildId: string) => apiGet<DownloadsResponse>(`${guildPath(guildId)}/downloads`),
  action: (guildId: string, body: GuildActionBody) =>
    apiPost<PlayerState>(`${guildPath(guildId)}/actions`, body),
  settings: (guildId: string) => apiGet<GuildSettings>(`${guildPath(guildId)}/settings`),
  updateSettings: (guildId: string, body: GuildSettingsUpdate) =>
    apiPut<GuildSettings>(`${guildPath(guildId)}/settings`, body),
  playlists: (guildId: string) => apiGet<PlaylistSummary[]>(`${guildPath(guildId)}/playlists`),
  createPlaylist: (guildId: string, body: { name: string; isShared?: boolean }) =>
    apiPost<PlaylistSummary>(`${guildPath(guildId)}/playlists`, { guildId, ...body }),
  playlist: (playlistId: string, guildId: string) =>
    apiGet<PlaylistDetail>(withGuildQuery(playlistPath(playlistId), guildId)),
  updatePlaylist: (
    playlistId: string,
    guildId: string,
    body: { name?: string; isShared?: boolean },
  ) => apiPatch<PlaylistDetail>(playlistPath(playlistId), { guildId, ...body }),
  deletePlaylist: (playlistId: string, guildId: string) =>
    apiDelete<unknown>(withGuildQuery(playlistPath(playlistId), guildId)),
  addPlaylistItem: (
    playlistId: string,
    guildId: string,
    body: { title: string; url: string; durationSec?: number | null; thumbnailUrl?: string | null },
  ) => apiPost<PlaylistItemView>(`${playlistPath(playlistId)}/items`, { guildId, ...body }),
  removePlaylistItem: (playlistId: string, guildId: string, itemId: string) =>
    apiDelete<unknown>(
      withGuildQuery(`${playlistPath(playlistId)}/items/${encodeURIComponent(itemId)}`, guildId),
    ),
  reorderPlaylist: (playlistId: string, guildId: string, itemIds: string[]) =>
    apiPost<PlaylistDetail>(`${playlistPath(playlistId)}/reorder`, { guildId, itemIds }),
  history: (guildId: string, limit: number, offset: number) =>
    apiGet<HistoryPage>(
      `${guildPath(guildId)}/history?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`,
    ),
  logout: () => apiPost<void>("/api/auth/logout"),
};
