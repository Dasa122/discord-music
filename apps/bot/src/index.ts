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
import { destroyAllPlayers } from "./player/registry.js";

setLogLevel(config.logLevel);

let client: Client | null = null;
let server: Server | null = null;
let shuttingDown = false;

async function main(): Promise<void> {
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

  const media = new YtdlpMediaEngine({
    ytdlp: {
      path: config.ytdlpPath,
      denoPath: config.denoPath,
      cookiesFile: config.ytdlpCookiesFile,
      proxy: config.ytdlpProxy,
      potProviderUrl: config.potProviderUrl,
    },
    ffmpegPath: config.ffmpegPath,
    cache: audioCache,
    prefetchEnabled: config.prefetchEnabled,
    prefetchMaxConcurrent: config.prefetchMaxConcurrent,
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
