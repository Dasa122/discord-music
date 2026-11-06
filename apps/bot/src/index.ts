import type { Server } from "node:http";
import type { Client } from "discord.js";
import { createDiscordClient } from "./client.js";
import { config } from "./config.js";
import { closeControlServer, createControlServer, startControlServer } from "./control/server.js";
import { closeDb, pingDb } from "./db/client.js";
import { logger, setLogLevel } from "./logger.js";
import { YtdlpMediaEngine } from "./media/media-engine.js";
import { destroyAllPlayers } from "./player/registry.js";

setLogLevel(config.logLevel);

let client: Client | null = null;
let server: Server | null = null;
let shuttingDown = false;

async function main(): Promise<void> {
  await pingDb();
  logger.info("database connection verified");

  const media = new YtdlpMediaEngine(
    {
      path: config.ytdlpPath,
      denoPath: config.denoPath,
      cookiesFile: config.ytdlpCookiesFile,
      proxy: config.ytdlpProxy,
      potProviderUrl: config.potProviderUrl,
    },
    config.ffmpegPath,
  );

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
