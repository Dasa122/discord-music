import { randomBytes } from "node:crypto";
import { session as sessionTable } from "@music/shared";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { failure, forbiddenFailure, unauthorizedFailure } from "../envelope.js";
import type { AppEnv, Session } from "../types.js";

export const SESSION_COOKIE = "sid";

export type SessionUser = { sub: string; name: string; groups: string[] };

export type SessionStore = {
  insert(row: Session): Promise<void>;
  find(id: string): Promise<Session | null>;
  delete(id: string): Promise<void>;
};

const dbSessionStore: SessionStore = {
  async insert(row) {
    await db.insert(sessionTable).values({
      id: row.id,
      authentikSub: row.sub,
      displayName: row.name,
      groups: row.groups,
      expiresAt: row.expiresAt,
    });
  },
  async find(id) {
    const [row] = await db.select().from(sessionTable).where(eq(sessionTable.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id,
      sub: row.authentikSub,
      name: row.displayName,
      groups: row.groups,
      expiresAt: row.expiresAt,
    };
  },
  async delete(id) {
    await db.delete(sessionTable).where(eq(sessionTable.id, id));
  },
};

let store: SessionStore = dbSessionStore;

/** Swap the persistence layer (tests use an in-memory store). Pass null to restore. */
export function setSessionStore(next: SessionStore | null): void {
  store = next ?? dbSessionStore;
}

function sessionTtlSeconds(): number {
  return config.sessionTtlDays * 24 * 60 * 60;
}

export async function createSession(user: SessionUser): Promise<string> {
  const id = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + sessionTtlSeconds() * 1000);
  await store.insert({ id, sub: user.sub, name: user.name, groups: user.groups, expiresAt });
  return id;
}

export async function getSession(c: Context): Promise<Session | null> {
  const id = getCookie(c, SESSION_COOKIE);
  if (!id) return null;

  const found = await store.find(id);
  if (!found) return null;

  if (found.expiresAt.getTime() <= Date.now()) {
    await store.delete(id);
    return null;
  }
  return found;
}

export async function destroySession(id: string): Promise<void> {
  await store.delete(id);
}

export function setSessionCookie(c: Context, id: string): void {
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    secure: config.sessionCookieSecure,
    sameSite: "Lax",
    path: "/",
    maxAge: sessionTtlSeconds(),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: config.sessionCookieSecure });
}

/** 401 without a session, 403 without the configured admin group. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const session = await getSession(c);
  if (!session) return c.json(unauthorizedFailure(), 401);
  if (!session.groups.includes(config.authentikAdminGroup)) {
    return c.json(
      forbiddenFailure(`Requires membership in the ${config.authentikAdminGroup} group`),
      403,
    );
  }
  c.set("session", session);
  await next();
});

export type SameOriginInput = {
  origin: string | null;
  referer: string | null;
  secFetchSite: string | null;
};

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * CSRF guard for cookie-authenticated mutations.
 *
 * Browsers send `Origin` on cross-site and same-site non-GET requests. When it
 * is absent (older agents, same-origin navigations) accept only an explicit
 * `Sec-Fetch-Site: same-origin`, otherwise fall back to the `Referer` origin.
 */
export function isSameOrigin(input: SameOriginInput, baseUrl: string): boolean {
  const expected = originOf(baseUrl);
  if (expected === null) return false;

  const source = input.origin ?? input.referer;
  if (source === null || source === "") {
    return input.secFetchSite === "same-origin";
  }
  return originOf(source) === expected;
}

export const requireSameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  const allowed = isSameOrigin(
    {
      origin: c.req.header("origin") ?? null,
      referer: c.req.header("referer") ?? null,
      secFetchSite: c.req.header("sec-fetch-site") ?? null,
    },
    config.publicBaseUrl,
  );

  if (!allowed) {
    return c.json(failure("CSRF_REJECTED", "Cross-origin request rejected"), 403);
  }
  await next();
});
