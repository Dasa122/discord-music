/**
 * Test-only environment defaults.
 *
 * `config.ts` validates at import time, so tests that import a module touching
 * config must call this *before* dynamically importing that module. Static
 * imports are hoisted above the call, which is why those modules are imported
 * with `await import(...)`.
 */
export function installTestEnv(overrides: Record<string, string> = {}): void {
  const defaults: Record<string, string> = {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/music_test",
    PUBLIC_BASE_URL: "https://music.example.test",
    BOT_INTERNAL_URL: "http://127.0.0.1:3001",
    BOT_CONTROL_SECRET: "test-control-secret-0123456789",
    AUTHENTIK_ISSUER: "https://auth.example.test/application/o/music/",
    AUTHENTIK_CLIENT_ID: "test-client-id",
    AUTHENTIK_CLIENT_SECRET: "test-client-secret",
    AUTHENTIK_REDIRECT_URI: "https://music.example.test/api/auth/callback",
    SESSION_COOKIE_SECURE: "false",
    AUTH_DEV_BYPASS: "0",
  };

  for (const [key, value] of Object.entries({ ...defaults, ...overrides })) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
