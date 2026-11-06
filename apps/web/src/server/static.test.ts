import { describe, expect, test } from "bun:test";
import { installTestEnv } from "./test-env.js";

installTestEnv();

const { contentTypeFor, isBlockedAssetPath } = await import("./static.js");

describe("isBlockedAssetPath", () => {
  test("blocks source maps in production, case-insensitively", () => {
    expect(isBlockedAssetPath("/assets/index-abc.js.map", true)).toBe(true);
    expect(isBlockedAssetPath("/assets/index-abc.JS.MAP", true)).toBe(true);
  });

  test("serves source maps outside production", () => {
    expect(isBlockedAssetPath("/assets/index-abc.js.map", false)).toBe(false);
  });

  test("does not block normal assets", () => {
    expect(isBlockedAssetPath("/assets/index-abc.js", true)).toBe(false);
    expect(isBlockedAssetPath("/index.html", true)).toBe(false);
    expect(isBlockedAssetPath("/", true)).toBe(false);
  });
});

describe("contentTypeFor", () => {
  test("maps build assets", () => {
    expect(contentTypeFor("/assets/index-abc.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("/assets/index-abc.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("/index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("/favicon.ico")).toBe("image/x-icon");
  });

  test("never advertises source maps as JSON", () => {
    expect(contentTypeFor("/assets/index-abc.js.map")).toBe("application/octet-stream");
  });

  test("unknown extensions are opaque bytes", () => {
    expect(contentTypeFor("/data.bin")).toBe("application/octet-stream");
    expect(contentTypeFor("/no-extension")).toBe("application/octet-stream");
  });
});
