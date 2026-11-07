import { z } from "zod";
import { parseAllowedGuildIds } from "./guild-allowlist.js";
import { DEFAULT_LOUDNESS_SETTINGS, DEFAULT_MAX_GAIN_DB } from "./media/ffmpeg.js";

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

const MIN_AUDIO_CACHE_BYTES = 64 * 1024 * 1024;

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
  IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(0).max(86_400).default(60),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  YTDLP_PATH: z.string().min(1).default("yt-dlp"),
  DENO_PATH: z.string().min(1).default("deno"),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  YTDLP_COOKIES_FILE: z.string().min(1).optional(),
  YTDLP_PROXY: z.url().optional(),
  POT_PROVIDER_URL: z.url().optional(),
  /** Persists the extractor's player/challenge work across invocations. */
  YTDLP_CACHE_DIR: z.string().trim().min(1).default("/tmp/yt-dlp-cache"),
  /** `local` keeps files on disk; `s3` uploads them to Garage/MinIO. */
  AUDIO_STORE: z.enum(["local", "s3"]).default("local"),
  /** Where downloaded audio is cached for the lifetime of a voice session. */
  AUDIO_CACHE_DIR: z.string().trim().min(1).default("/data/audio"),
  /** Safety-net LRU cap for a single very long session. */
  AUDIO_CACHE_MAX_BYTES: z.coerce.number().int().min(MIN_AUDIO_CACHE_BYTES).default(1_610_612_736),
  /** Prefetch the next queued track; playback still streams when disabled. */
  PREFETCH_ENABLED: z
    .string()
    .trim()
    .toLowerCase()
    .default("true")
    .transform((value) => !["false", "0", "no", "off"].includes(value)),
  PREFETCH_MAX_CONCURRENT: z.coerce.number().int().min(1).max(4).default(2),
  /** Refuse individual downloads larger than this. */
  AUDIO_CACHE_MAX_FILE_BYTES: z.coerce.number().int().min(1).default(67_108_864),
  /** Perceived-volume levelling applied to decoded PCM before Discord. */
  AUDIO_NORMALIZE: z
    .enum(["loudnorm", "dynaudnorm", "off"])
    .default(DEFAULT_LOUDNESS_SETTINGS.mode),
  AUDIO_TARGET_LUFS: z.coerce
    .number()
    .min(-30, "must be between -30 and -5")
    .max(-5, "must be between -30 and -5")
    .default(DEFAULT_LOUDNESS_SETTINGS.targetLufs),
  AUDIO_TRUE_PEAK_DB: z.coerce
    .number()
    .min(-6, "must be between -6 and 0")
    .max(0, "must be between -6 and 0")
    .default(DEFAULT_LOUDNESS_SETTINGS.truePeakDb),
  AUDIO_LRA: z.coerce
    .number()
    .min(1, "must be between 1 and 20")
    .max(20, "must be between 1 and 20")
    .default(DEFAULT_LOUDNESS_SETTINGS.lra),
  AUDIO_DYN_FRAME_MS: z.coerce
    .number()
    .min(10, "must be between 10 and 500")
    .max(500, "must be between 10 and 500")
    .default(DEFAULT_LOUDNESS_SETTINGS.dynFrameMs),
  /** Measure cached tracks once and replay their exact gain; false skips analysis. */
  AUDIO_TWO_PASS: z
    .string()
    .trim()
    .toLowerCase()
    .default("true")
    .transform((value) => !["false", "0", "no", "off"].includes(value)),
  /** Symmetric bound on a measured gain, in dB. */
  AUDIO_MAX_GAIN_DB: z.coerce
    .number()
    .min(0, "must be between 0 and 24")
    .max(24, "must be between 0 and 24")
    .default(DEFAULT_MAX_GAIN_DB),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().trim().min(1).default("garage"),
  S3_BUCKET: z.string().trim().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
  S3_FORCE_PATH_STYLE: z
    .string()
    .trim()
    .toLowerCase()
    .default("true")
    .transform((value) => !["false", "0", "no", "off"].includes(value)),
  S3_PREFIX: z.string().trim().default("audio"),
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
  ytdlpCacheDir: string;
  audioStore: "local" | "s3";
  audioCacheDir: string;
  audioCacheMaxBytes: number;
  prefetchEnabled: boolean;
  prefetchMaxConcurrent: number;
  audioCacheMaxFileBytes: number;
  audioNormalize: "loudnorm" | "dynaudnorm" | "off";
  audioTargetLufs: number;
  audioTruePeakDb: number;
  audioLra: number;
  audioDynFrameMs: number;
  audioTwoPass: boolean;
  audioMaxGainDb: number;
  s3Endpoint: string | undefined;
  s3Region: string;
  s3Bucket: string | undefined;
  s3AccessKeyId: string | undefined;
  s3SecretAccessKey: string | undefined;
  s3ForcePathStyle: boolean;
  s3Prefix: string;
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

  if (value.AUDIO_STORE === "s3") {
    const missingS3 = (
      [
        ["S3_ENDPOINT", value.S3_ENDPOINT],
        ["S3_BUCKET", value.S3_BUCKET],
        ["S3_ACCESS_KEY_ID", value.S3_ACCESS_KEY_ID],
        ["S3_SECRET_ACCESS_KEY", value.S3_SECRET_ACCESS_KEY],
      ] as const
    )
      .filter(([, configured]) => configured === undefined)
      .map(([key]) => key);
    if (missingS3.length > 0) {
      throw new Error(
        `Invalid environment configuration: AUDIO_STORE=s3 requires ${missingS3.join(", ")}.`,
      );
    }
  }

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
    ytdlpCacheDir: value.YTDLP_CACHE_DIR,
    audioStore: value.AUDIO_STORE,
    audioCacheDir: value.AUDIO_CACHE_DIR,
    audioCacheMaxBytes: value.AUDIO_CACHE_MAX_BYTES,
    prefetchEnabled: value.PREFETCH_ENABLED,
    prefetchMaxConcurrent: value.PREFETCH_MAX_CONCURRENT,
    audioCacheMaxFileBytes: value.AUDIO_CACHE_MAX_FILE_BYTES,
    audioNormalize: value.AUDIO_NORMALIZE,
    audioTargetLufs: value.AUDIO_TARGET_LUFS,
    audioTruePeakDb: value.AUDIO_TRUE_PEAK_DB,
    audioLra: value.AUDIO_LRA,
    audioDynFrameMs: value.AUDIO_DYN_FRAME_MS,
    audioTwoPass: value.AUDIO_TWO_PASS,
    audioMaxGainDb: value.AUDIO_MAX_GAIN_DB,
    s3Endpoint: value.S3_ENDPOINT,
    s3Region: value.S3_REGION,
    s3Bucket: value.S3_BUCKET,
    s3AccessKeyId: value.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: value.S3_SECRET_ACCESS_KEY,
    s3ForcePathStyle: value.S3_FORCE_PATH_STYLE,
    s3Prefix: value.S3_PREFIX,
    databaseUrl: value.DATABASE_URL,
  });
}

/** Parsed at import time so a misconfigured process fails before doing anything. */
export const config: AppConfig = loadConfig();
