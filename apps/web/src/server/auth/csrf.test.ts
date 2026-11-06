import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { installTestEnv } from "../test-env.js";
import type { AppEnv } from "../types.js";

installTestEnv();

const { isSameOrigin, requireSameOrigin } = await import("./session.js");

const BASE = "https://music.example.test";

describe("isSameOrigin", () => {
  test("accepts an identical origin", () => {
    expect(isSameOrigin({ origin: BASE, referer: null, secFetchSite: null }, BASE)).toBe(true);
  });

  test("accepts a trailing slash on the base URL", () => {
    expect(isSameOrigin({ origin: BASE, referer: null, secFetchSite: null }, `${BASE}/`)).toBe(
      true,
    );
  });

  test("rejects a different host, scheme or port", () => {
    for (const origin of [
      "https://evil.example.test",
      "http://music.example.test",
      "https://music.example.test:8443",
      "https://sub.music.example.test",
    ]) {
      expect(isSameOrigin({ origin, referer: null, secFetchSite: null }, BASE)).toBe(false);
    }
  });

  test("rejects the literal null origin", () => {
    expect(isSameOrigin({ origin: "null", referer: null, secFetchSite: null }, BASE)).toBe(false);
  });

  test("falls back to the referer origin", () => {
    expect(
      isSameOrigin(
        { origin: null, referer: `${BASE}/guilds/123?tab=queue`, secFetchSite: null },
        BASE,
      ),
    ).toBe(true);
    expect(
      isSameOrigin(
        { origin: null, referer: "https://evil.example.test/attack", secFetchSite: null },
        BASE,
      ),
    ).toBe(false);
  });

  test("origin wins over referer", () => {
    expect(
      isSameOrigin(
        { origin: "https://evil.example.test", referer: `${BASE}/guilds`, secFetchSite: null },
        BASE,
      ),
    ).toBe(false);
  });

  test("allows missing origin only with Sec-Fetch-Site: same-origin", () => {
    expect(isSameOrigin({ origin: null, referer: null, secFetchSite: "same-origin" }, BASE)).toBe(
      true,
    );
    expect(isSameOrigin({ origin: null, referer: null, secFetchSite: "same-site" }, BASE)).toBe(
      false,
    );
    expect(isSameOrigin({ origin: null, referer: null, secFetchSite: "cross-site" }, BASE)).toBe(
      false,
    );
    expect(isSameOrigin({ origin: null, referer: null, secFetchSite: null }, BASE)).toBe(false);
  });
});

describe("requireSameOrigin middleware", () => {
  const app = new Hono<AppEnv>();
  app.post("/mutate", requireSameOrigin, (c) => c.json({ success: true, data: null }));

  test("allows same-origin mutations", async () => {
    const response = await app.request("/mutate", {
      method: "POST",
      headers: { origin: BASE },
    });
    expect(response.status).toBe(200);
  });

  test("rejects cross-origin mutations with 403 CSRF_REJECTED", async () => {
    const response = await app.request("/mutate", {
      method: "POST",
      headers: { origin: "https://evil.example.test" },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CSRF_REJECTED");
  });

  test("rejects header-less mutations", async () => {
    const response = await app.request("/mutate", { method: "POST" });
    expect(response.status).toBe(403);
  });
});
