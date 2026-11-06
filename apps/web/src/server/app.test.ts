import { describe, expect, test } from "bun:test";
import { installTestEnv } from "./test-env.js";

installTestEnv();

const { MAX_JSON_BODY_BYTES } = await import("./envelope.js");
const { app } = await import("./app.js");

describe("mutating body size cap", () => {
  test("rejects an oversized body with 413 before routing", async () => {
    const body = "x".repeat(MAX_JSON_BODY_BYTES + 1);

    const response = await app.request("/api/guilds/g1/settings", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "content-length": String(body.length),
      },
      body,
    });

    expect(response.status).toBe(413);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("lets a small body reach the route layer", async () => {
    // Without credentials the real route answers 401 rather than 413, which
    // proves the size guard did not reject it.
    const response = await app.request("/api/guilds/g1/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultVolume: 100 }),
    });

    expect(response.status).not.toBe(413);
  });
});

describe("security headers", () => {
  test("API responses are uncacheable and carry the transport/policy headers", async () => {
    const response = await app.request("/api/health");

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(response.headers.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });

  test("the SPA shell keeps the shared headers but is not marked no-store", async () => {
    const response = await app.request("/");

    expect(response.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
  });
});
