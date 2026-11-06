import { describe, expect, test } from "bun:test";
import { isUniqueViolation } from "./errors.js";

describe("isUniqueViolation", () => {
  test("detects postgres.js string SQLSTATE", () => {
    expect(isUniqueViolation({ code: "23505", message: "duplicate key" })).toBe(true);
  });

  test("detects numeric errno variants", () => {
    expect(isUniqueViolation({ errno: 23505 })).toBe(true);
    expect(isUniqueViolation({ code: 23505 })).toBe(true);
    expect(isUniqueViolation({ sqlState: "23505" })).toBe(true);
  });

  test("detects a wrapped cause", () => {
    const wrapped = new Error("query failed", { cause: { code: "23505" } });
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  test("detects the playlist unique constraint by name", () => {
    expect(
      isUniqueViolation({
        code: "23505",
        constraint: "playlist_guild_id_name_unique",
      }),
    ).toBe(true);
  });

  test("ignores unrelated errors and non-objects", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  test("terminates on a self-referential cause chain", () => {
    const loop: { code: string; cause?: unknown } = { code: "XX000" };
    loop.cause = loop;
    expect(isUniqueViolation(loop)).toBe(false);
  });
});
