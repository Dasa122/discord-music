import { describe, expect, test } from "bun:test";
import { isGuildAllowed, parseAllowedGuildIds } from "./guild-allowlist.js";

describe("parseAllowedGuildIds", () => {
  test("empty and unset mean every guild", () => {
    expect(parseAllowedGuildIds(undefined)).toEqual([]);
    expect(parseAllowedGuildIds("")).toEqual([]);
    expect(parseAllowedGuildIds("   ")).toEqual([]);
  });

  test("splits, trims, and de-duplicates", () => {
    expect(parseAllowedGuildIds(" 1 , 2,2 ,, 3 ")).toEqual(["1", "2", "3"]);
  });
});

describe("isGuildAllowed", () => {
  test("an empty allow-list allows everything", () => {
    expect(isGuildAllowed([], "g1")).toBe(true);
  });

  test("only listed guilds pass", () => {
    expect(isGuildAllowed(["g1", "g2"], "g1")).toBe(true);
    expect(isGuildAllowed(["g1", "g2"], "g3")).toBe(false);
  });

  test("DMs are not guilds and are left to the command checks", () => {
    expect(isGuildAllowed(["g1"], null)).toBe(true);
  });
});
