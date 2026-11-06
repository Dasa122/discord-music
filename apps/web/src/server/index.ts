import { app } from "./app.js";
import { config } from "./config.js";
import { closeDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";

async function main(): Promise<void> {
  const migrations = await runMigrations();
  console.log(
    JSON.stringify({
      level: "info",
      msg: "migrations_applied",
      applied: migrations.applied,
      folder: migrations.folder,
    }),
  );

  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
  });

  console.log(
    JSON.stringify({
      level: "info",
      msg: "listening",
      port: server.port,
      url: `http://localhost:${server.port}`,
      publicBaseUrl: config.publicBaseUrl,
      env: config.nodeEnv,
    }),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: "info", msg: "shutdown", signal }));
    try {
      await server.stop(true);
    } finally {
      await closeDb();
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

await main();
