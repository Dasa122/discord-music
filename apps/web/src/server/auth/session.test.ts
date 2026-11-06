import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { installTestEnv } from "../test-env.js";
import type { AppEnv, Session } from "../types.js";
import type { SessionStore } from "./session.js";

installTestEnv();

const { SESSION_COOKIE, createSession, requireAdmin, setSessionStore } = await import(
  "./session.js"
);

type MemoryStore = SessionStore & { rows: Map<string, Session> };

function createMemoryStore(): MemoryStore {
  const rows = new Map<string, Session>();
  return {
    rows,
    insert: async (row) => {
      rows.set(row.id, row);
    },
    find: async (id) => rows.get(id) ?? null,
    delete: async (id) => {
      rows.delete(id);
    },
  };
}

let store: MemoryStore;

beforeEach(() => {
  store = createMemoryStore();
  setSessionStore(store);
});

function adminApp() {
  const app = new Hono<AppEnv>();
  app.use("/admin/*", requireAdmin);
  app.get("/admin/protected", (c) =>
    c.json({ success: true, data: { sub: c.get("session").sub, name: c.get("session").name } }),
  );
  return app;
}

describe("createSession", () => {
  test("stores a 64 character hex id and a future expiry", async () => {
    const before = Date.now();
    const id = await createSession({ sub: "user-1", name: "Ada", groups: ["music-admins"] });

    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const row = store.rows.get(id);
    expect(row).toBeDefined();
    if (!row) throw new Error("missing row");
    expect(row.sub).toBe("user-1");
    expect(row.name).toBe("Ada");
    expect(row.groups).toEqual(["music-admins"]);
    expect(row.expiresAt.getTime()).toBeGreaterThan(before);
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(before + 7 * 24 * 60 * 60 * 1000 + 1_000);
  });
});

describe("requireAdmin", () => {
  test("401 without a session cookie", async () => {
    const response = await adminApp().request("/admin/protected");
    expect(response.status).toBe(401);
    const body = (await response.json()) as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("401 for an unknown session id", async () => {
    const response = await adminApp().request("/admin/protected", {
      headers: { cookie: `${SESSION_COOKIE}=does-not-exist` },
    });
    expect(response.status).toBe(401);
  });

  test("403 when the session lacks the admin group", async () => {
    const id = await createSession({ sub: "user-2", name: "Bob", groups: ["listeners"] });
    const response = await adminApp().request("/admin/protected", {
      headers: { cookie: `${SESSION_COOKIE}=${id}` },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("200 and attaches the session for an admin", async () => {
    const id = await createSession({ sub: "user-3", name: "Cleo", groups: ["music-admins"] });
    const response = await adminApp().request("/admin/protected", {
      headers: { cookie: `${SESSION_COOKIE}=${id}` },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: { sub: string; name: string };
    };
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ sub: "user-3", name: "Cleo" });
  });

  test("expired sessions are rejected and deleted", async () => {
    const id = await createSession({ sub: "user-4", name: "Dana", groups: ["music-admins"] });
    const row = store.rows.get(id);
    if (!row) throw new Error("missing row");
    row.expiresAt = new Date(Date.now() - 1_000);

    const response = await adminApp().request("/admin/protected", {
      headers: { cookie: `${SESSION_COOKIE}=${id}` },
    });

    expect(response.status).toBe(401);
    expect(store.rows.has(id)).toBe(false);
  });
});
