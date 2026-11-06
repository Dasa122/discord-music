import { describe, expect, test } from "bun:test";
import { installTestEnv } from "./test-env.js";

installTestEnv();

const { DEFAULT_SESSION_TTL_DAYS, loadConfig } = await import("./config.js");

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/music_test",
    PUBLIC_BASE_URL: "https://music.example.test",
    BOT_INTERNAL_URL: "http://127.0.0.1:3001",
    BOT_CONTROL_SECRET: "test-control-secret-0123456789",
    AUTHENTIK_ISSUER: "https://auth.example.test/application/o/music/",
    AUTHENTIK_CLIENT_ID: "test-client-id",
    AUTHENTIK_CLIENT_SECRET: "test-client-secret",
    AUTHENTIK_REDIRECT_URI: "https://music.example.test/api/auth/callback",
    SESSION_COOKIE_SECURE: "true",
    ...overrides,
  };
}

describe("loadConfig NODE_ENV", () => {
  test("defaults to development", () => {
    const env = baseEnv();
    delete env.NODE_ENV;
    expect(loadConfig(env).nodeEnv).toBe("development");
  });

  test("accepts production, development, and test", () => {
    for (const value of ["production", "development", "test"] as const) {
      const config = loadConfig(baseEnv({ NODE_ENV: value, SESSION_COOKIE_SECURE: "true" }));
      expect(config.nodeEnv).toBe(value);
      expect(config.isProduction).toBe(value === "production");
    }
  });

  test("normalises casing and padding", () => {
    expect(loadConfig(baseEnv({ NODE_ENV: " PRODUCTION " })).nodeEnv).toBe("production");
  });

  test("rejects an unknown environment instead of guessing", () => {
    expect(() => loadConfig(baseEnv({ NODE_ENV: "staging" }))).toThrow(/NODE_ENV/);
    expect(() => loadConfig(baseEnv({ NODE_ENV: "prod" }))).toThrow(/NODE_ENV/);
    expect(() => loadConfig(baseEnv({ NODE_ENV: "" }))).toThrow(/NODE_ENV/);
  });
});

describe("loadConfig session TTL", () => {
  test("defaults to a 24 hour session", () => {
    const env = baseEnv();
    delete env.SESSION_TTL_DAYS;
    const config = loadConfig(env);

    expect(DEFAULT_SESSION_TTL_DAYS).toBe(1);
    expect(config.sessionTtlDays).toBe(1);
    expect(config.sessionTtlDays * 24 * 60 * 60).toBe(86_400);
  });

  test("honours an explicit TTL", () => {
    expect(loadConfig(baseEnv({ SESSION_TTL_DAYS: "3" })).sessionTtlDays).toBe(3);
  });
});

describe("loadConfig cookie hardening", () => {
  test("refuses an insecure cookie in production", () => {
    expect(() =>
      loadConfig(baseEnv({ NODE_ENV: "production", SESSION_COOKIE_SECURE: "false" })),
    ).toThrow(/SESSION_COOKIE_SECURE/);
  });

  test("allows an insecure cookie outside production", () => {
    expect(
      loadConfig(baseEnv({ NODE_ENV: "development", SESSION_COOKIE_SECURE: "false" }))
        .sessionCookieSecure,
    ).toBe(false);
  });

  test("still refuses the dev bypass in production", () => {
    expect(() => loadConfig(baseEnv({ NODE_ENV: "production", AUTH_DEV_BYPASS: "true" }))).toThrow(
      /AUTH_DEV_BYPASS/,
    );
  });
});
