import { describe, expect, test } from "bun:test";
import { queryKeys } from "./api";

describe("queryKeys", () => {
  test("is stable for the same arguments", () => {
    expect(queryKeys.guilds()).toEqual(queryKeys.guilds());
    expect(queryKeys.state("guild-1")).toEqual(queryKeys.state("guild-1"));
    expect(queryKeys.downloads("guild-1")).toEqual(queryKeys.downloads("guild-1"));
    expect(queryKeys.settings("guild-1")).toEqual(queryKeys.settings("guild-1"));
    expect(queryKeys.playlists("guild-1")).toEqual(queryKeys.playlists("guild-1"));
    expect(queryKeys.playlist("playlist-1")).toEqual(queryKeys.playlist("playlist-1"));
    expect(queryKeys.history("guild-1", 2)).toEqual(queryKeys.history("guild-1", 2));
  });

  test("changes when the guild or page changes", () => {
    expect(queryKeys.state("guild-1")).not.toEqual(queryKeys.state("guild-2"));
    expect(queryKeys.downloads("guild-1")).not.toEqual(queryKeys.downloads("guild-2"));
    expect(queryKeys.settings("guild-1")).not.toEqual(queryKeys.settings("guild-2"));
    expect(queryKeys.history("guild-1", 1)).not.toEqual(queryKeys.history("guild-1", 2));
  });

  test("namespaces guild-scoped keys under the guild id", () => {
    expect(queryKeys.state("guild-1")).toEqual(["guilds", "guild-1", "state"]);
    expect(queryKeys.playlist("playlist-1")).toEqual(["playlists", "playlist-1"]);
  });
});
