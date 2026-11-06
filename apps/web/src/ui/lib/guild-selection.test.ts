import { describe, expect, test } from "bun:test";
import { resolveSelectedGuildId } from "./guild-selection";

describe("resolveSelectedGuildId", () => {
  const guildIds = ["guild-1", "guild-2"];

  test("prefers the URL guild over localStorage and the first guild", () => {
    expect(resolveSelectedGuildId("guild-2", "guild-1", guildIds)).toBe("guild-2");
  });

  test("keeps an unknown URL guild so the guild guard can explain it", () => {
    expect(resolveSelectedGuildId("guild-foreign", "guild-1", guildIds)).toBe("guild-foreign");
  });

  test("falls back to the stored guild when no URL guild is present", () => {
    expect(resolveSelectedGuildId(null, "guild-2", guildIds)).toBe("guild-2");
  });

  test("ignores a stored guild that is no longer available", () => {
    expect(resolveSelectedGuildId(null, "guild-gone", guildIds)).toBe("guild-1");
  });

  test("falls back to the first guild", () => {
    expect(resolveSelectedGuildId(null, null, guildIds)).toBe("guild-1");
  });

  test("returns null when there are no guilds", () => {
    expect(resolveSelectedGuildId(null, null, [])).toBeNull();
  });

  test("trims whitespace and ignores empty values", () => {
    expect(resolveSelectedGuildId("  guild-2  ", null, guildIds)).toBe("guild-2");
    expect(resolveSelectedGuildId("   ", "  ", guildIds)).toBe("guild-1");
  });
});
