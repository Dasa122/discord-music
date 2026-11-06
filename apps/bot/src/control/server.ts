import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { ControlAction, QueueTrack } from "@music/shared";
import { controlActionSchema } from "@music/shared";
import type { Client } from "discord.js";
import { config } from "../config.js";
import { getPlaylistWithItems } from "../db/client.js";
import { MediaError, PlayerError } from "../errors.js";
import { logger } from "../logger.js";
import { toQueueTracks } from "../media/track.js";
import type { GuildPlayer } from "../player/guild-player.js";
import {
  getClientGuildCount,
  getMedia,
  getPlayer,
  listGuildSummaries,
} from "../player/registry.js";
import { mapControlError } from "./errors.js";

const MAX_BODY_BYTES = 256 * 1024;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function createControlServer(client: Client): Server {
  return createServer((request, response) => {
    void handleRequest(client, request, response).catch((error: unknown) => {
      logger.error("control request crashed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.writableEnded) {
        sendJson(response, 500, {
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "Unexpected server error." },
        });
      }
    });
  });
}

export async function startControlServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.controlPort, config.controlHost);
  });

  logger.info("control server listening", {
    host: config.controlHost,
    port: config.controlPort,
  });
}

export async function closeControlServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function handleRequest(
  client: Client,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const startedAt = Date.now();
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (!secretMatches(request.headers["x-control-secret"])) {
      sendJson(response, 401, {
        ok: false,
        error: { code: "UNAUTHORIZED", message: "Missing or invalid X-Control-Secret." },
      });
      return;
    }

    if (method === "GET" && pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        guilds: getClientGuildCount(),
      });
      return;
    }

    if (method === "GET" && pathname === "/guilds") {
      sendJson(response, 200, { guilds: await listGuildSummaries(client) });
      return;
    }

    const match = /^\/guilds\/([^/]+)\/(state|actions)$/.exec(pathname);
    if (!match) {
      sendJson(response, 404, {
        ok: false,
        error: { code: "NOT_FOUND", message: "Unknown control route." },
      });
      return;
    }

    const guildId = decodeURIComponent(match[1] ?? "");
    const route = match[2];
    if (!guildId || !client.guilds.cache.has(guildId)) {
      sendJson(response, 404, {
        ok: false,
        error: { code: "GUILD_NOT_FOUND", message: "The bot is not in that guild." },
      });
      return;
    }

    if (route === "state") {
      if (method !== "GET") {
        sendJson(response, 405, {
          ok: false,
          error: { code: "METHOD_NOT_ALLOWED", message: "Use GET." },
        });
        return;
      }
      const player = await getPlayer(guildId);
      await player.ensureSettings();
      sendJson(response, 200, player.getState());
      return;
    }

    if (method !== "POST") {
      sendJson(response, 405, {
        ok: false,
        error: { code: "METHOD_NOT_ALLOWED", message: "Use POST." },
      });
      return;
    }

    const body = await readJsonBody(request);
    const parsed = controlActionSchema.safeParse(body);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; ");
      throw new HttpError(400, "INVALID_ACTION", `Invalid control action: ${details}`);
    }

    const player = await applyAction(guildId, parsed.data);
    sendJson(response, 200, { ok: true, data: player.getState() });
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(response, error.status, {
        ok: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }

    const mapped = mapControlError(error);
    if (mapped.status >= 500) {
      logger.error("control action failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    sendJson(response, mapped.status, mapped.body);
  } finally {
    logger.debug("control request", {
      method,
      path: pathname,
      status: response.statusCode,
      durationMs: Date.now() - startedAt,
    });
  }
}

async function applyAction(guildId: string, action: ControlAction): Promise<GuildPlayer> {
  const player = await getPlayer(guildId);
  await player.ensureSettings();

  switch (action.type) {
    case "play": {
      if (!player.getState().connected) {
        throw new PlayerError("NOT_CONNECTED", "The bot is not connected to a voice channel.");
      }
      if (action.textChannelId) player.setTextChannel(action.textChannelId);

      const resolved = await getMedia().resolve(action.query);
      const tracks = toQueueTracks(resolved, action.requestedBy);
      if (tracks.length === 0) {
        throw new MediaError("NOT_FOUND", "No playable tracks were found.");
      }
      await player.enqueue(tracks);
      break;
    }

    case "playPlaylist": {
      if (!player.getState().connected) {
        throw new PlayerError("NOT_CONNECTED", "The bot is not connected to a voice channel.");
      }
      if (action.textChannelId) player.setTextChannel(action.textChannelId);

      const loaded = await getPlaylistWithItems(action.playlistId);
      if (!loaded) {
        throw new PlayerError("GUILD_NOT_FOUND", "Playlist not found.");
      }

      const tracks: QueueTrack[] = loaded.items.map((item) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        durationSec: item.durationSec,
        thumbnailUrl: item.thumbnailUrl,
        source: "unknown",
        requestedBy: action.requestedBy,
      }));
      if (tracks.length === 0) {
        throw new PlayerError("NOTHING_PLAYING", "That playlist is empty.");
      }
      await player.enqueue(tracks);
      break;
    }

    case "pause":
      player.pause();
      break;
    case "resume":
      player.resume();
      break;
    case "skip":
      await player.skip(action.count ?? 1);
      break;
    case "stop":
      await player.stop();
      break;
    case "seek":
      await player.seek(action.positionSec);
      break;
    case "volume":
      player.setVolume(action.volume);
      break;
    case "loop":
      player.setLoop(action.mode);
      break;
    case "shuffle":
      player.shuffle();
      break;
    case "remove":
      player.remove(action.index);
      break;
    case "move":
      player.move(action.from, action.to);
      break;
    case "clear":
      player.clear();
      break;
    case "disconnect":
      await player.disconnect();
      break;
  }

  return player;
}

function secretMatches(header: string | string[] | undefined): boolean {
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(config.controlSecret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;

    request.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds 256 KB."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      if (failed) return;
      if (size === 0) {
        reject(new HttpError(400, "INVALID_BODY", "A JSON body is required."));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "INVALID_JSON", "Request body must be valid JSON."));
      }
    });

    request.on("error", (error) => {
      if (!failed) reject(error);
    });
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}
