import { describe, expect, test } from "bun:test";

// `config.ts` parses the process environment at import time; give it valid
// placeholders before the module is evaluated.
process.env.DISCORD_TOKEN ??= "test-discord-token";
process.env.DISCORD_CLIENT_ID ??= "test-client-id";
process.env.BOT_CONTROL_SECRET ??= "test-control-secret-0123456789";
process.env.DATABASE_URL ??= "postgres://postgres:postgres@127.0.0.1:5432/music_test";

const { loadConfig } = await import("./config.js");

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: "discord-token",
    DISCORD_CLIENT_ID: "client-id",
    BOT_CONTROL_SECRET: "control-secret-0123456789",
    DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/music_test",
    ...overrides,
  };
}

describe("loadConfig normalises pasted values", () => {
  test("trims trailing newlines and surrounding spaces", () => {
    const config = loadConfig(
      baseEnv({
        DISCORD_TOKEN: " discord-token\n",
        DISCORD_CLIENT_ID: "client-id\r\n",
        DISCORD_GUILD_ID: " 123456789012345678 \n",
        BOT_CONTROL_SECRET: " control-secret-0123456789\n",
        DATABASE_URL: " postgres://postgres:postgres@127.0.0.1:5432/music_test\n",
      }),
    );

    expect(config.discordToken).toBe("discord-token");
    expect(config.discordClientId).toBe("client-id");
    expect(config.discordGuildId).toBe("123456789012345678");
    expect(config.controlSecret).toBe("control-secret-0123456789");
    expect(config.databaseUrl).toBe("postgres://postgres:postgres@127.0.0.1:5432/music_test");
  });

  test("strips one pair of surrounding double or single quotes", () => {
    const doubleQuoted = loadConfig(
      baseEnv({
        DISCORD_TOKEN: '"discord-token"',
        DATABASE_URL: '"postgres://postgres:postgres@127.0.0.1:5432/music_test"',
      }),
    );
    expect(doubleQuoted.discordToken).toBe("discord-token");
    expect(doubleQuoted.databaseUrl).toBe("postgres://postgres:postgres@127.0.0.1:5432/music_test");

    const singleQuoted = loadConfig(
      baseEnv({
        DISCORD_CLIENT_ID: "'client-id'",
        BOT_CONTROL_SECRET: "'control-secret-0123456789'",
      }),
    );
    expect(singleQuoted.discordClientId).toBe("client-id");
    expect(singleQuoted.controlSecret).toBe("control-secret-0123456789");
  });

  test("treats a quoted empty optional value as unset", () => {
    expect(loadConfig(baseEnv({ DISCORD_GUILD_ID: '""' })).discordGuildId).toBeUndefined();
    expect(loadConfig(baseEnv({ DISCORD_GUILD_ID: "  " })).discordGuildId).toBeUndefined();
  });

  test("keeps the required-key error when a value is only whitespace", () => {
    expect(() => loadConfig(baseEnv({ DISCORD_TOKEN: "   \n" }))).toThrow(
      /Missing required environment variables: DISCORD_TOKEN/,
    );
  });
});

describe("loadConfig audio storage", () => {
  test("defaults to a 60 s idle timeout and local storage", () => {
    const config = loadConfig(baseEnv());
    expect(config.idleTimeoutSeconds).toBe(60);
    expect(config.audioStore).toBe("local");
    expect(config.audioCacheDir).toBe("/data/audio");
    expect(config.audioCacheMaxBytes).toBe(1_610_612_736);
    expect(config.prefetchEnabled).toBe(true);
    expect(config.s3ForcePathStyle).toBe(true);
  });

  test("s3 without its required keys fails with a clear list", () => {
    expect(() => loadConfig(baseEnv({ AUDIO_STORE: "s3" }))).toThrow(
      /AUDIO_STORE=s3 requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/,
    );
  });

  test("s3 with every key is accepted", () => {
    const config = loadConfig(
      baseEnv({
        AUDIO_STORE: "s3",
        S3_ENDPOINT: "http://garage:3900",
        S3_BUCKET: "music",
        S3_ACCESS_KEY_ID: "key",
        S3_SECRET_ACCESS_KEY: "secret",
        S3_PREFIX: "audio",
      }),
    );
    expect(config.audioStore).toBe("s3");
    expect(config.s3Bucket).toBe("music");
    expect(config.s3Region).toBe("garage");
  });

  test("local ignores partial S3 variables", () => {
    const config = loadConfig(baseEnv({ S3_BUCKET: "music" }));
    expect(config.audioStore).toBe("local");
  });
});
