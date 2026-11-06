import { z } from "zod";
import { parseAllowedGuildIds } from "./guild-allowlist.js";

/**
 * Pasted values routinely carry a trailing newline or surrounding quotes; both
 * break Discord's auth and the database URL. Normalise before validation.
 */
const normalizeEnvValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  let normalized = value.trim();
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized === "" ? undefined : normalized;
};

const envSchema = z.object({
  DISCORD_TOKEN: z.string().trim().min(1),
  DISCORD_CLIENT_ID: z.string().trim().min(1),
  DISCORD_GUILD_ID: z.string().trim().min(1).optional(),
  /** Optional comma-separated allow-list; empty means every guild. */
  DISCORD_ALLOWED_GUILD_IDS: z.string().optional(),
  BOT_CONTROL_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  BOT_CONTROL_HOST: z.string().min(1).default("127.0.0.1"),
  BOT_CONTROL_SECRET: z.string().trim().min(16),
  MAX_CONCURRENT_STREAMS: z.coerce.number().int().min(1).max(100).default(3),
  IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  YTDLP_PATH: z.string().min(1).default("yt-dlp"),
  DENO_PATH: z.string().min(1).default("deno"),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  YTDLP_COOKIES_FILE: z.string().min(1).optional(),
  YTDLP_PROXY: z.url().optional(),
  POT_PROVIDER_URL: z.url().optional(),
  DATABASE_URL: z.string().trim().min(1),
});

const REQUIRED_KEYS = [
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "BOT_CONTROL_SECRET",
  "DATABASE_URL",
] as const;

export interface AppConfig {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string | undefined;
  allowedGuildIds: readonly string[];
  controlPort: number;
  controlHost: string;
  controlSecret: string;
  maxConcurrentStreams: number;
  idleTimeoutSeconds: number;
  logLevel: "debug" | "info" | "warn" | "error";
  ytdlpPath: string;
  denoPath: string;
  ffmpegPath: string;
  ytdlpCookiesFile: string | undefined;
  ytdlpProxy: string | undefined;
  potProviderUrl: string | undefined;
  databaseUrl: string;
}

/**
 * Validate the process environment. Throws a single readable error that names
 * every missing required key instead of failing on the first one.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const normalized = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, normalizeEnvValue(value)]),
  );

  const missing = REQUIRED_KEYS.filter((key) => normalized[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. See .env.example for the full list.`,
    );
  }

  const parsed = envSchema.safeParse(normalized);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const value = parsed.data;
  return Object.freeze({
    discordToken: value.DISCORD_TOKEN,
    discordClientId: value.DISCORD_CLIENT_ID,
    discordGuildId: value.DISCORD_GUILD_ID,
    allowedGuildIds: parseAllowedGuildIds(value.DISCORD_ALLOWED_GUILD_IDS),
    controlPort: value.BOT_CONTROL_PORT,
    controlHost: value.BOT_CONTROL_HOST,
    controlSecret: value.BOT_CONTROL_SECRET,
    maxConcurrentStreams: value.MAX_CONCURRENT_STREAMS,
    idleTimeoutSeconds: value.IDLE_TIMEOUT_SECONDS,
    logLevel: value.LOG_LEVEL,
    ytdlpPath: value.YTDLP_PATH,
    denoPath: value.DENO_PATH,
    ffmpegPath: value.FFMPEG_PATH,
    ytdlpCookiesFile: value.YTDLP_COOKIES_FILE,
    ytdlpProxy: value.YTDLP_PROXY,
    potProviderUrl: value.POT_PROVIDER_URL,
    databaseUrl: value.DATABASE_URL,
  });
}

/** Parsed at import time so a misconfigured process fails before doing anything. */
export const config: AppConfig = loadConfig();
