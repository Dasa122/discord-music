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

describe("loadConfig loudness normalization", () => {
  test("defaults to one-pass loudnorm at -16 LUFS", () => {
    const config = loadConfig(baseEnv());
    expect(config.audioNormalize).toBe("loudnorm");
    expect(config.audioTargetLufs).toBe(-16);
    expect(config.audioTruePeakDb).toBe(-1.5);
    expect(config.audioLra).toBe(11);
    expect(config.audioDynFrameMs).toBe(150);
    expect(config.audioTwoPass).toBe(true);
    expect(config.audioMaxGainDb).toBe(12);
  });

  test("two-pass can be disabled and the gain cap is configurable", () => {
    const disabled = loadConfig(baseEnv({ AUDIO_TWO_PASS: " FALSE\n", AUDIO_MAX_GAIN_DB: " 6 " }));
    expect(disabled.audioTwoPass).toBe(false);
    expect(disabled.audioMaxGainDb).toBe(6);
  });

  test("trims and accepts every mode and its knobs", () => {
    const dynamic = loadConfig(
      baseEnv({
        AUDIO_NORMALIZE: " dynaudnorm\n",
        AUDIO_DYN_FRAME_MS: " 300 ",
      }),
    );
    expect(dynamic.audioNormalize).toBe("dynaudnorm");
    expect(dynamic.audioDynFrameMs).toBe(300);

    const custom = loadConfig(
      baseEnv({
        AUDIO_NORMALIZE: "loudnorm",
        AUDIO_TARGET_LUFS: "-23",
        AUDIO_TRUE_PEAK_DB: "-2",
        AUDIO_LRA: "7",
      }),
    );
    expect(custom.audioTargetLufs).toBe(-23);
    expect(custom.audioTruePeakDb).toBe(-2);
    expect(custom.audioLra).toBe(7);

    expect(loadConfig(baseEnv({ AUDIO_NORMALIZE: "off" })).audioNormalize).toBe("off");
  });

  test("rejects out-of-range values and names the variable", () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ AUDIO_TARGET_LUFS: "-31" }, /AUDIO_TARGET_LUFS: must be between -30 and -5/],
      [{ AUDIO_TARGET_LUFS: "-4" }, /AUDIO_TARGET_LUFS: must be between -30 and -5/],
      [{ AUDIO_TRUE_PEAK_DB: "-7" }, /AUDIO_TRUE_PEAK_DB: must be between -6 and 0/],
      [{ AUDIO_TRUE_PEAK_DB: "1" }, /AUDIO_TRUE_PEAK_DB: must be between -6 and 0/],
      [{ AUDIO_LRA: "0" }, /AUDIO_LRA: must be between 1 and 20/],
      [{ AUDIO_LRA: "21" }, /AUDIO_LRA: must be between 1 and 20/],
      [{ AUDIO_DYN_FRAME_MS: "9" }, /AUDIO_DYN_FRAME_MS: must be between 10 and 500/],
      [{ AUDIO_DYN_FRAME_MS: "501" }, /AUDIO_DYN_FRAME_MS: must be between 10 and 500/],
      [{ AUDIO_MAX_GAIN_DB: "-1" }, /AUDIO_MAX_GAIN_DB: must be between 0 and 24/],
      [{ AUDIO_MAX_GAIN_DB: "25" }, /AUDIO_MAX_GAIN_DB: must be between 0 and 24/],
    ];
    for (const [overrides, expected] of cases) {
      expect(() => loadConfig(baseEnv(overrides))).toThrow(expected);
    }
  });

  test("rejects an unknown AUDIO_NORMALIZE mode", () => {
    expect(() => loadConfig(baseEnv({ AUDIO_NORMALIZE: "peak" }))).toThrow(
      /AUDIO_NORMALIZE: Invalid option/,
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

describe("loadConfig opus bitrate", () => {
  test("defaults to 96 kbps", () => {
    expect(loadConfig(baseEnv()).audioBitrateKbps).toBe(96);
  });

  test("accepts the 16..128 kbps range and trims pasted input", () => {
    expect(loadConfig(baseEnv({ AUDIO_BITRATE_KBPS: " 64\n" })).audioBitrateKbps).toBe(64);
    expect(loadConfig(baseEnv({ AUDIO_BITRATE_KBPS: "16" })).audioBitrateKbps).toBe(16);
    expect(loadConfig(baseEnv({ AUDIO_BITRATE_KBPS: "128" })).audioBitrateKbps).toBe(128);
  });

  test("rejects values outside the range", () => {
    expect(() => loadConfig(baseEnv({ AUDIO_BITRATE_KBPS: "15" }))).toThrow(
      /AUDIO_BITRATE_KBPS: must be between 16 and 128/,
    );
    expect(() => loadConfig(baseEnv({ AUDIO_BITRATE_KBPS: "129" }))).toThrow(
      /AUDIO_BITRATE_KBPS: must be between 16 and 128/,
    );
    expect(() => loadConfig(baseEnv({ AUDIO_BITRATE_KBPS: "200" }))).toThrow(
      /AUDIO_BITRATE_KBPS: must be between 16 and 128/,
    );
  });
});

describe("loadConfig fast-start tuning", () => {
  test("defaults to a 250 ms stream prebuffer and prefetch depth 2", () => {
    const config = loadConfig(baseEnv());
    expect(config.streamPrebufferMs).toBe(250);
    expect(config.prefetchDepth).toBe(2);
  });

  test("accepts the stream prebuffer range 100..2000", () => {
    expect(loadConfig(baseEnv({ STREAM_PREBUFFER_MS: " 100\n" })).streamPrebufferMs).toBe(100);
    expect(loadConfig(baseEnv({ STREAM_PREBUFFER_MS: "2000" })).streamPrebufferMs).toBe(2000);
  });

  test("accepts the prefetch depth range 1..3", () => {
    expect(loadConfig(baseEnv({ PREFETCH_DEPTH: "1" })).prefetchDepth).toBe(1);
    expect(loadConfig(baseEnv({ PREFETCH_DEPTH: " 3 " })).prefetchDepth).toBe(3);
  });

  test("rejects out-of-range values and names the variable", () => {
    expect(() => loadConfig(baseEnv({ STREAM_PREBUFFER_MS: "99" }))).toThrow(
      /STREAM_PREBUFFER_MS: must be between 100 and 2000/,
    );
    expect(() => loadConfig(baseEnv({ STREAM_PREBUFFER_MS: "2001" }))).toThrow(
      /STREAM_PREBUFFER_MS: must be between 100 and 2000/,
    );
    expect(() => loadConfig(baseEnv({ PREFETCH_DEPTH: "0" }))).toThrow(
      /PREFETCH_DEPTH: must be between 1 and 3/,
    );
    expect(() => loadConfig(baseEnv({ PREFETCH_DEPTH: "4" }))).toThrow(
      /PREFETCH_DEPTH: must be between 1 and 3/,
    );
  });
});
