import { describe, expect, test } from "bun:test";
import { decodePathSegment } from "./path.js";

describe("decodePathSegment", () => {
  test("decodes a plain segment", () => {
    expect(decodePathSegment("1234567890")).toBe("1234567890");
  });

  test("decodes percent-encoded characters", () => {
    expect(decodePathSegment("a%20b")).toBe("a b");
  });

  test("returns null for malformed percent-encoding", () => {
    expect(decodePathSegment("%E0%A4%A")).toBeNull();
    expect(decodePathSegment("%")).toBeNull();
  });
});
