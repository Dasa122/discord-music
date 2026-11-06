import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Minimal OpenID Connect authorization-code client with PKCE (S256).
 *
 * The client secret never leaves this module's server-side token request. No
 * token is persisted: only the resulting `sub`/`name`/`groups` snapshot is
 * stored on the app session.
 */

export const OAUTH_STATE_COOKIE = "oauth_state";
export const OAUTH_NONCE_COOKIE = "oauth_nonce";
export const OAUTH_VERIFIER_COOKIE = "oauth_verifier";
const OAUTH_COOKIE_MAX_AGE_SECONDS = 600;
const DISCOVERY_TTL_MS = 5 * 60_000;
const HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_SCOPE = "openid profile email";
/** Provider error bodies are diagnostics only: cap the bytes we read. */
const MAX_ERROR_BODY_BYTES = 4 * 1024;
const MAX_ERROR_CODE_LENGTH = 64;
const MAX_ERROR_DESCRIPTION_LENGTH = 200;

export class AuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

export type TokenErrorDiagnostics = {
  error?: string;
  errorDescription?: string;
};

function sanitizeProviderText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = Array.from(value)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return undefined;
  return cleaned.slice(0, maxLength);
}

/**
 * Extract only the OAuth `error`/`error_description` pair from a provider
 * response. Tokens and every other field are ignored, so they can never be
 * retained or logged.
 */
export function parseTokenErrorBody(text: string): TokenErrorDiagnostics {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof body !== "object" || body === null) return {};

  const record = body as Record<string, unknown>;
  const diagnostics: TokenErrorDiagnostics = {};
  const error = sanitizeProviderText(record.error, MAX_ERROR_CODE_LENGTH);
  const errorDescription = sanitizeProviderText(
    record.error_description,
    MAX_ERROR_DESCRIPTION_LENGTH,
  );
  if (error !== undefined) diagnostics.error = error;
  if (errorDescription !== undefined) diagnostics.errorDescription = errorDescription;
  return diagnostics;
}

/** Read at most `limit` bytes from a response body, then stop. */
async function readLimitedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const slice = value.subarray(0, limit - total);
      chunks.push(slice);
      total += slice.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

const discoverySchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  userinfo_endpoint: z.url().optional(),
});

export type OidcDiscovery = z.infer<typeof discoverySchema>;

export type AuthentikUser = { sub: string; name: string; groups: string[] };

export type AuthorizeRequest = {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
};

let discoveryCache: { value: OidcDiscovery; expiresAt: number } | null = null;
let discoveryInFlight: Promise<OidcDiscovery> | null = null;
let jwksCache: { uri: string; value: ReturnType<typeof createRemoteJWKSet> } | null = null;

export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

async function fetchDiscovery(): Promise<OidcDiscovery> {
  let response: Response;
  try {
    response = await fetch(discoveryUrl(config.authentikIssuer), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    logger.warn({ event: "oidc_discovery_failed", code: "DISCOVERY_UNAVAILABLE" });
    throw new AuthError("DISCOVERY_UNAVAILABLE", "The identity provider could not be reached", 502);
  }
  if (!response.ok) {
    logger.warn({
      event: "oidc_discovery_failed",
      code: "DISCOVERY_FAILED",
      status: response.status,
    });
    throw new AuthError(
      "DISCOVERY_FAILED",
      "The identity provider discovery document is unavailable",
      502,
    );
  }

  const body: unknown = await response.json().catch(() => null);
  const parsed = discoverySchema.safeParse(body);
  if (!parsed.success) {
    logger.warn({ event: "oidc_discovery_failed", code: "DISCOVERY_INVALID" });
    throw new AuthError(
      "DISCOVERY_INVALID",
      "The identity provider discovery document is invalid",
      502,
    );
  }
  return parsed.data;
}

export async function getDiscovery(): Promise<OidcDiscovery> {
  if (discoveryCache && discoveryCache.expiresAt > Date.now()) return discoveryCache.value;
  if (discoveryInFlight) return discoveryInFlight;

  discoveryInFlight = fetchDiscovery()
    .then((value) => {
      discoveryCache = { value, expiresAt: Date.now() + DISCOVERY_TTL_MS };
      return value;
    })
    .finally(() => {
      discoveryInFlight = null;
    });

  return discoveryInFlight;
}

/** RFC 7636 S256 challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function buildAuthorizeUrlFrom(
  discovery: OidcDiscovery,
  options: {
    clientId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
    scope?: string;
  },
): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", options.scope ?? DEFAULT_SCOPE);
  url.searchParams.set("state", options.state);
  url.searchParams.set("nonce", options.nonce);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function buildAuthorizeUrl(): Promise<AuthorizeRequest> {
  const discovery = await getDiscovery();
  const { verifier, challenge } = createPkcePair();
  const state = randomToken(32);
  const nonce = randomToken(32);

  const url = buildAuthorizeUrlFrom(discovery, {
    clientId: config.authentikClientId,
    redirectUri: config.authentikRedirectUri,
    state,
    nonce,
    codeChallenge: challenge,
  });

  return { url, state, nonce, codeVerifier: verifier };
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function stateMatches(actual: string, expected: string): boolean {
  return constantTimeEquals(actual, expected);
}

export function assertNonceMatch(actual: unknown, expected: string): void {
  if (typeof actual !== "string" || !constantTimeEquals(actual, expected)) {
    logger.warn({ event: "oidc_nonce_mismatch", code: "INVALID_NONCE" });
    throw new AuthError("INVALID_NONCE", "Sign-in verification failed", 400);
  }
}

function stringGroups(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function fallbackName(claims: Record<string, unknown>, sub: string): string {
  for (const key of ["name", "preferred_username", "email"] as const) {
    const value = claims[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return sub;
}

function getJwks(uri: string): ReturnType<typeof createRemoteJWKSet> {
  if (jwksCache && jwksCache.uri === uri) return jwksCache.value;
  const value = createRemoteJWKSet(new URL(uri));
  jwksCache = { uri, value };
  return value;
}

async function fetchUserInfo(
  discovery: OidcDiscovery,
  accessToken: string,
): Promise<AuthentikUser> {
  if (!discovery.userinfo_endpoint) {
    throw new AuthError(
      "USERINFO_UNAVAILABLE",
      "The identity provider did not expose a userinfo endpoint",
      502,
    );
  }

  let response: Response;
  try {
    response = await fetch(discovery.userinfo_endpoint, {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new AuthError("USERINFO_FAILED", "The identity provider userinfo request failed", 502);
  }
  if (!response.ok) {
    throw new AuthError("USERINFO_FAILED", "The identity provider userinfo request failed", 502);
  }

  const body: unknown = await response.json().catch(() => null);
  if (body === null || typeof body !== "object") {
    throw new AuthError(
      "USERINFO_INVALID",
      "The identity provider returned an invalid profile",
      502,
    );
  }

  const claims = body as Record<string, unknown>;
  if (typeof claims.sub !== "string" || claims.sub === "") {
    throw new AuthError(
      "USERINFO_INVALID",
      "The identity provider returned an invalid profile",
      502,
    );
  }

  return {
    sub: claims.sub,
    name: fallbackName(claims, claims.sub),
    groups: stringGroups(claims.groups),
  };
}

async function verifyIdToken(
  idToken: string,
  discovery: OidcDiscovery,
  expectedNonce: string,
  accessToken: string | undefined,
): Promise<AuthentikUser> {
  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(idToken, getJwks(discovery.jwks_uri), {
      issuer: discovery.issuer,
      audience: config.authentikClientId,
    });
    claims = verified.payload as Record<string, unknown>;
  } catch {
    logger.warn({ event: "oidc_id_token_invalid", code: "INVALID_ID_TOKEN", stage: "verify" });
    throw new AuthError("INVALID_ID_TOKEN", "The identity provider returned an invalid token", 401);
  }

  assertNonceMatch(claims.nonce, expectedNonce);

  const sub = claims.sub;
  if (typeof sub !== "string" || sub === "") {
    logger.warn({ event: "oidc_id_token_invalid", code: "INVALID_ID_TOKEN", stage: "subject" });
    throw new AuthError("INVALID_ID_TOKEN", "The identity provider returned an invalid token", 401);
  }

  const tokenGroups = Array.isArray(claims.groups) ? stringGroups(claims.groups) : null;
  if (tokenGroups !== null) {
    return { sub, name: fallbackName(claims, sub), groups: tokenGroups };
  }

  if (accessToken) {
    const profile = await fetchUserInfo(discovery, accessToken);
    return { sub, name: fallbackName(claims, sub), groups: profile.groups };
  }

  return { sub, name: fallbackName(claims, sub), groups: [] };
}

type TokenResponse = { id_token?: unknown; access_token?: unknown };

/**
 * OIDC requires an ID token from the code exchange. Falling back to userinfo
 * would accept a response that never proved the nonce, so a missing
 * `id_token` is a hard failure.
 */
export function requireIdToken(tokenResponse: unknown): string {
  const record =
    typeof tokenResponse === "object" && tokenResponse !== null
      ? (tokenResponse as Record<string, unknown>)
      : null;
  const idToken = record?.id_token;
  if (typeof idToken !== "string" || idToken === "") {
    logger.warn({ event: "oidc_missing_id_token", code: "MISSING_ID_TOKEN" });
    throw new AuthError(
      "MISSING_ID_TOKEN",
      "The identity provider did not return an ID token",
      401,
    );
  }
  return idToken;
}

export async function exchangeCode(
  code: string,
  verifier: string,
  expectedNonce: string,
): Promise<AuthentikUser> {
  const discovery = await getDiscovery();

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.authentikRedirectUri,
    client_id: config.authentikClientId,
    client_secret: config.authentikClientSecret,
    code_verifier: verifier,
  });

  let response: Response;
  try {
    response = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new AuthError("TOKEN_EXCHANGE_FAILED", "The identity provider could not be reached", 502);
  }

  if (!response.ok) {
    // Only the provider's OAuth error code/description leave this block; tokens
    // and every other field are never read into memory or logged.
    const diagnostics = parseTokenErrorBody(
      await readLimitedText(response, MAX_ERROR_BODY_BYTES).catch(() => ""),
    );
    logger.warn({
      event: "oidc_token_exchange_failed",
      status: response.status,
      error: diagnostics.error,
      errorDescription: diagnostics.errorDescription,
    });
    throw new AuthError(
      "TOKEN_EXCHANGE_FAILED",
      diagnostics.error
        ? `Authentication with the identity provider failed (${diagnostics.error})`
        : "Authentication with the identity provider failed",
      502,
    );
  }

  const body: unknown = await response.json().catch(() => null);
  if (body === null || typeof body !== "object") {
    throw new AuthError(
      "TOKEN_RESPONSE_INVALID",
      "The identity provider returned an invalid token response",
      502,
    );
  }

  const token = body as TokenResponse;
  const idToken = requireIdToken(token);
  const accessToken = typeof token.access_token === "string" ? token.access_token : undefined;
  return verifyIdToken(idToken, discovery, expectedNonce, accessToken);
}

function oauthCookieOptions() {
  return {
    httpOnly: true,
    secure: config.sessionCookieSecure,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: OAUTH_COOKIE_MAX_AGE_SECONDS,
  };
}

export function setOAuthCookies(
  c: Context,
  values: { state: string; nonce: string; codeVerifier: string },
): void {
  const options = oauthCookieOptions();
  setCookie(c, OAUTH_STATE_COOKIE, values.state, options);
  setCookie(c, OAUTH_NONCE_COOKIE, values.nonce, options);
  setCookie(c, OAUTH_VERIFIER_COOKIE, values.codeVerifier, options);
}

export function clearOAuthCookies(c: Context): void {
  for (const name of [OAUTH_STATE_COOKIE, OAUTH_NONCE_COOKIE, OAUTH_VERIFIER_COOKIE]) {
    deleteCookie(c, name, { path: "/", secure: config.sessionCookieSecure });
  }
}
