import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";
import type { Client } from "discord.js";
import { createDiscordClient } from "./client.js";
import { config } from "./config.js";
import { closeControlServer, createControlServer, startControlServer } from "./control/server.js";
import { closeDb, pingDb } from "./db/client.js";
import { logger, setLogLevel } from "./logger.js";
import { AudioCache } from "./media/audio-cache.js";
import { selectAudioStore } from "./media/audio-store.js";
import { YtdlpMediaEngine } from "./media/media-engine.js";
import { createMusicLinkResolver } from "./media/providers/index.js";
import { createResolver } from "./media/resolver/index.js";
import { destroyAllPlayers } from "./player/registry.js";
import {
  assertDaveAvailable,
  detectVoiceCapabilities,
  logVoiceCapabilities,
} from "./voice-capabilities.js";

setLogLevel(config.logLevel);

let client: Client | null = null;
let server: Server | null = null;
let shuttingDown = false;

async function main(): Promise<void> {
  // Discord requires DAVE/E2EE for voice. A bot without it still connects and
  // reports "playing" while Discord drops every frame — refuse to start instead.
  const capabilities = await detectVoiceCapabilities();
  logVoiceCapabilities(capabilities);
  try {
    assertDaveAvailable(capabilities);
  } catch (error) {
    logger.error("voice_dave_missing", {
      hint: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  await pingDb();
  logger.info("database connection verified");

  const selection = await selectAudioStore({
    mode: config.audioStore,
    localDir: config.audioCacheDir,
    s3:
      config.audioStore === "s3" &&
      config.s3Endpoint &&
      config.s3Bucket &&
      config.s3AccessKeyId &&
      config.s3SecretAccessKey
        ? {
            endpoint: config.s3Endpoint,
            region: config.s3Region,
            bucket: config.s3Bucket,
            accessKeyId: config.s3AccessKeyId,
            secretAccessKey: config.s3SecretAccessKey,
            forcePathStyle: config.s3ForcePathStyle,
          }
        : undefined,
  });

  const audioCache = new AudioCache({
    store: selection.store,
    mode: selection.mode,
    maxBytes: config.audioCacheMaxBytes,
    prefix: selection.mode === "s3" ? config.s3Prefix : "",
    cacheDir: config.audioCacheDir,
    tempRoot: join(process.env.TMPDIR?.trim() || "/tmp", "music-audio"),
  });
  await audioCache.init();
  logger.info("audio store ready", { store: selection.mode });

  // yt-dlp caches its player/JS-challenge work here; the directory must exist
  // before the first extraction.
  await mkdir(config.ytdlpCacheDir, { recursive: true }).catch((error: unknown) => {
    logger.warn("could not create yt-dlp cache dir", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const ytdlp = {
    path: config.ytdlpPath,
    denoPath: config.denoPath,
    cookiesFile: config.ytdlpCookiesFile,
    proxy: config.ytdlpProxy,
    potProviderUrl: config.potProviderUrl,
    cacheDir: config.ytdlpCacheDir,
  };
  // RESOLVER=ytdlp (the default) keeps the pre-P2 extractor path untouched.
  const resolver = createResolver({
    resolver: config.resolver,
    innertubeClient: config.innertubeClient,
    failureThreshold: config.resolverFailureThreshold,
    cooldownMs: config.resolverCooldownMs,
    ytdlp,
  });

  const media = new YtdlpMediaEngine({
    ytdlp,
    resolver,
    musicLinks: createMusicLinkResolver({
      spotifyClientId: config.spotifyClientId,
      spotifyClientSecret: config.spotifyClientSecret,
      maxTracks: config.musicLinkMaxTracks,
    }),
    musicLinkMaxTracks: config.musicLinkMaxTracks,
    ffmpegPath: config.ffmpegPath,
    normalization: {
      mode: config.audioNormalize,
      targetLufs: config.audioTargetLufs,
      truePeakDb: config.audioTruePeakDb,
      lra: config.audioLra,
      dynFrameMs: config.audioDynFrameMs,
    },
    cache: audioCache,
    twoPass: config.audioTwoPass,
    maxGainDb: config.audioMaxGainDb,
    prefetchEnabled: config.prefetchEnabled,
    prefetchMaxConcurrent: config.prefetchMaxConcurrent,
    streamPrebufferMs: config.streamPrebufferMs,
    maxCacheFileBytes: config.audioCacheMaxFileBytes,
  });

  client = createDiscordClient(media);
  server = createControlServer(client);
  await startControlServer(server);

  await client.login(config.discordToken);
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });

  try {
    await destroyAllPlayers();
  } catch (error) {
    logger.warn("failed to destroy players", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await closeDb();
  } catch (error) {
    logger.warn("failed to close database", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (server) {
    try {
      await closeControlServer(server);
    } catch (error) {
      logger.warn("failed to close control server", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  client?.destroy();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled promise rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});

main().catch((error: unknown) => {
  logger.error("fatal startup error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
