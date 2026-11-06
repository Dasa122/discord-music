import { describe, expect, test } from "bun:test";
import {
  canDeletePlaylist,
  canLoadPlaylist,
  canManagePlaylists,
  canUseDjControls,
  canUsePlayerButtons,
  type GuildActor,
} from "./permissions.js";

const admin: GuildActor = { hasDjRole: false, hasManageGuild: true };
const dj: GuildActor = { hasDjRole: true, hasManageGuild: false };
const member: GuildActor = { hasDjRole: false, hasManageGuild: false };

describe("canUseDjControls", () => {
  test("an unconfigured DJ role lets everyone through", () => {
    expect(canUseDjControls(member, null)).toBe(true);
  });

  test("a configured DJ role requires the role or Manage Guild", () => {
    expect(canUseDjControls(dj, "dj-role")).toBe(true);
    expect(canUseDjControls(admin, "dj-role")).toBe(true);
    expect(canUseDjControls(member, "dj-role")).toBe(false);
  });
});

describe("canUsePlayerButtons", () => {
  const inBotChannel = { ...member, voiceChannelId: "voice-1" };

  test("requires the clicker to share the bot's voice channel", () => {
    expect(canUsePlayerButtons(inBotChannel, null, "voice-1")).toBe(true);
    expect(canUsePlayerButtons({ ...member, voiceChannelId: "voice-2" }, null, "voice-1")).toBe(
      false,
    );
    expect(canUsePlayerButtons({ ...member, voiceChannelId: null }, null, "voice-1")).toBe(false);
    expect(canUsePlayerButtons(inBotChannel, null, null)).toBe(false);
  });

  test("still applies the DJ gate", () => {
    expect(canUsePlayerButtons(inBotChannel, "dj-role")).toBe(false);
    expect(canUsePlayerButtons({ ...dj, voiceChannelId: "voice-1" }, "dj-role", "voice-1")).toBe(
      true,
    );
  });

  test("Manage Guild bypasses both the role and the channel check", () => {
    expect(canUsePlayerButtons({ ...admin, voiceChannelId: null }, "dj-role", "voice-1")).toBe(
      true,
    );
  });
});

describe("playlist authorization", () => {
  test("save requires Manage Guild or the DJ role", () => {
    expect(canManagePlaylists(admin)).toBe(true);
    expect(canManagePlaylists(dj)).toBe(true);
    expect(canManagePlaylists(member)).toBe(false);
  });

  test("delete also requires ownership unless the caller is an admin", () => {
    const owned = { ownerDiscordId: "me" };
    const other = { ownerDiscordId: "someone-else" };

    expect(canDeletePlaylist({ ...dj, userId: "me" }, owned)).toBe(true);
    expect(canDeletePlaylist({ ...dj, userId: "me" }, other)).toBe(false);
    expect(canDeletePlaylist({ ...admin, userId: "me" }, other)).toBe(true);
    expect(canDeletePlaylist({ ...member, userId: "me" }, owned)).toBe(false);
  });

  test("load requires a shared playlist or ownership", () => {
    expect(canLoadPlaylist({ userId: "me" }, { ownerDiscordId: "me", isShared: false })).toBe(true);
    expect(canLoadPlaylist({ userId: "me" }, { ownerDiscordId: "x", isShared: true })).toBe(true);
    expect(canLoadPlaylist({ userId: "me" }, { ownerDiscordId: "x", isShared: false })).toBe(false);
  });
});
