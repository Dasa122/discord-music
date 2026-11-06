import type { Context } from "hono";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  AuthError,
  buildAuthorizeUrl,
  clearOAuthCookies,
  exchangeCode,
  OAUTH_NONCE_COOKIE,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  setOAuthCookies,
  stateMatches,
} from "../auth/authentik.js";
import type { SessionUser } from "../auth/session.js";
import {
  clearSessionCookie,
  destroySession,
  getSession,
  replaceSession,
  requireAdmin,
  setSessionCookie,
} from "../auth/session.js";
import { config } from "../config.js";
import { success } from "../envelope.js";
import type { AppEnv } from "../types.js";

/** Mounted at `/api/auth`. */
export const authRoutes = new Hono<AppEnv>();

/** Mounted at `/api` (the spec exposes `/api/me`, not `/api/auth/me`). */
export const meRoutes = new Hono<AppEnv>();

const DEV_USER: SessionUser = {
  sub: "dev",
  name: "Dev Admin",
  groups: [config.authentikAdminGroup],
};

/** Re-check the provider's group claim before any session is created or reused. */
function isAdminUser(user: SessionUser): boolean {
  return user.groups.includes(config.authentikAdminGroup);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function errorPage(
  c: Context<AppEnv>,
  status: 400 | 401 | 403 | 502,
  title: string,
  detail: string,
): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} — Discord Music</title>
  </head>
  <body style="font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 32rem; line-height: 1.5;">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
    <p><a href="/">Return to the dashboard</a></p>
  </body>
</html>`;
  return c.html(html, status);
}

authRoutes.get("/login", async (c) => {
  if (config.authDevBypass) {
    // Reuse a valid session instead of inserting a second row on every visit.
    const existing = await getSession(c);
    if (existing) return c.redirect("/", 302);

    const id = await replaceSession(c, DEV_USER);
    setSessionCookie(c, id);
    return c.redirect("/", 302);
  }

  let request: Awaited<ReturnType<typeof buildAuthorizeUrl>>;
  try {
    request = await buildAuthorizeUrl();
  } catch (error) {
    if (error instanceof AuthError) {
      return errorPage(
        c,
        502,
        "Sign-in unavailable",
        "The identity provider could not be reached.",
      );
    }
    throw error;
  }

  setOAuthCookies(c, {
    state: request.state,
    nonce: request.nonce,
    codeVerifier: request.codeVerifier,
  });
  return c.redirect(request.url, 302);
});

authRoutes.get("/callback", async (c) => {
  const providerError = c.req.query("error");
  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookieState = getCookie(c, OAUTH_STATE_COOKIE);
  const cookieNonce = getCookie(c, OAUTH_NONCE_COOKIE);
  const verifier = getCookie(c, OAUTH_VERIFIER_COOKIE);

  clearOAuthCookies(c);

  if (providerError) {
    return errorPage(
      c,
      400,
      "Sign-in failed",
      c.req.query("error_description") ?? "The identity provider rejected the sign-in.",
    );
  }
  if (!code || !state) {
    return errorPage(
      c,
      400,
      "Sign-in failed",
      "The identity provider did not return an authorization code.",
    );
  }
  if (!cookieState || !cookieNonce || !verifier) {
    return errorPage(c, 400, "Sign-in expired", "The sign-in took too long. Please start again.");
  }
  if (!stateMatches(state, cookieState)) {
    return errorPage(
      c,
      400,
      "Sign-in failed",
      "The sign-in state did not match. Please start again.",
    );
  }

  let user: SessionUser;
  try {
    user = await exchangeCode(code, verifier, cookieNonce);
  } catch (error) {
    if (error instanceof AuthError) {
      const status =
        error.status === 400 || error.status === 401 || error.status === 403 ? error.status : 502;
      return errorPage(c, status, "Sign-in failed", error.message);
    }
    throw error;
  }

  if (!isAdminUser(user)) {
    return errorPage(
      c,
      403,
      "Access denied",
      `Your account is not a member of the ${config.authentikAdminGroup} group.`,
    );
  }

  const id = await replaceSession(c, user);
  setSessionCookie(c, id);
  return c.redirect("/", 302);
});

authRoutes.post("/logout", async (c) => {
  const session = await getSession(c);
  if (session) await destroySession(session.id);
  clearSessionCookie(c);
  return c.json(success(null), 200);
});

meRoutes.get("/me", requireAdmin, (c) => {
  const session = c.get("session");
  return c.json(success({ sub: session.sub, name: session.name, groups: session.groups }));
});
