import { z } from "zod";

/**
 * Environment parsing for the web service.
 *
 * Validation happens once at import time so a misconfigured container fails at
 * boot instead of at the first request. Error messages name the offending keys
 * but never echo their values (several of them are secrets).
 */

const booleanEnv = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value.trim() === "" ? String(fallback) : value.trim().toLowerCase(),
    )
    .pipe(
      z.enum(["true", "false", "1", "0"]).transform((value) => value === "true" || value === "1"),
    );

const stripTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const envSchema = z.object({
  NODE_ENV: z.string().min(1).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  PUBLIC_BASE_URL: z.url().transform(stripTrailingSlash),
  BOT_INTERNAL_URL: z.url().transform(stripTrailingSlash),
  BOT_CONTROL_SECRET: z.string().min(16),
  AUTHENTIK_ISSUER: z.url().transform(stripTrailingSlash),
  AUTHENTIK_CLIENT_ID: z.string().min(1),
  AUTHENTIK_CLIENT_SECRET: z.string().min(1),
  AUTHENTIK_REDIRECT_URI: z.url(),
  AUTHENTIK_ADMIN_GROUP: z.string().min(1).default("music-admins"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  SESSION_COOKIE_SECURE: booleanEnv(true),
  AUTH_DEV_BYPASS: booleanEnv(false),
});

export type Config = {
  readonly nodeEnv: string;
  readonly isProduction: boolean;
  readonly port: number;
  readonly databaseUrl: string;
  readonly publicBaseUrl: string;
  readonly botInternalUrl: string;
  readonly botControlSecret: string;
  readonly authentikIssuer: string;
  readonly authentikClientId: string;
  readonly authentikClientSecret: string;
  readonly authentikRedirectUri: string;
  readonly authentikAdminGroup: string;
  readonly sessionTtlDays: number;
  readonly sessionCookieSecure: boolean;
  readonly authDevBypass: boolean;
};

function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid web environment configuration: ${details}`);
  }

  const value = parsed.data;
  if (value.AUTH_DEV_BYPASS && value.NODE_ENV === "production") {
    throw new Error("AUTH_DEV_BYPASS must not be enabled when NODE_ENV=production");
  }

  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    isProduction: value.NODE_ENV === "production",
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    publicBaseUrl: value.PUBLIC_BASE_URL,
    botInternalUrl: value.BOT_INTERNAL_URL,
    botControlSecret: value.BOT_CONTROL_SECRET,
    authentikIssuer: value.AUTHENTIK_ISSUER,
    authentikClientId: value.AUTHENTIK_CLIENT_ID,
    authentikClientSecret: value.AUTHENTIK_CLIENT_SECRET,
    authentikRedirectUri: value.AUTHENTIK_REDIRECT_URI,
    authentikAdminGroup: value.AUTHENTIK_ADMIN_GROUP,
    sessionTtlDays: value.SESSION_TTL_DAYS,
    sessionCookieSecure: value.SESSION_COOKIE_SECURE,
    authDevBypass: value.AUTH_DEV_BYPASS,
  });
}

export const config: Config = loadConfig(process.env);
