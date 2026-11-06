import { describe, expect, test } from "bun:test";
import { VoiceConnectionStatus } from "@discordjs/voice";
import {
  failureNotice,
  isSettingsStale,
  isSuppressedIdle,
  SETTINGS_TTL_MS,
  shouldIdleDisconnect,
  startBlocker,
  VOICE_DISCONNECT_GRACE_MS,
  voiceTransitionAction,
} from "./lifecycle.js";

describe("voiceTransitionAction", () => {
  test("destroyed connections tear down immediately", () => {
    expect(voiceTransitionAction(VoiceConnectionStatus.Destroyed)).toBe("teardown");
  });

  test("disconnected connections get a grace window", () => {
    expect(voiceTransitionAction(VoiceConnectionStatus.Disconnected)).toBe("schedule-teardown");
  });

  test("ready cancels a pending teardown", () => {
    expect(voiceTransitionAction(VoiceConnectionStatus.Ready)).toBe("cancel-teardown");
  });

  test("transient states are ignored", () => {
    expect(voiceTransitionAction(VoiceConnectionStatus.Connecting)).toBe("none");
    expect(voiceTransitionAction(VoiceConnectionStatus.Signalling)).toBe("none");
  });

  test("the grace window is a finite positive duration", () => {
    expect(VOICE_DISCONNECT_GRACE_MS).toBeGreaterThan(0);
  });
});

describe("isSettingsStale", () => {
  test("never-loaded settings are always stale", () => {
    expect(isSettingsStale(null, 1_000)).toBe(true);
  });

  test("settings are fresh for the TTL and stale afterwards", () => {
    expect(isSettingsStale(1_000, 1_000 + SETTINGS_TTL_MS - 1)).toBe(false);
    expect(isSettingsStale(1_000, 1_000 + SETTINGS_TTL_MS)).toBe(true);
  });
});

describe("shouldIdleDisconnect", () => {
  test("an empty queue disconnects regardless of humans", () => {
    expect(shouldIdleDisconnect(true, null)).toBe(true);
    expect(shouldIdleDisconnect(true, 4)).toBe(true);
  });

  test("a channel with humans stays connected", () => {
    expect(shouldIdleDisconnect(false, 2)).toBe(false);
  });

  test("an empty channel disconnects", () => {
    expect(shouldIdleDisconnect(false, 0)).toBe(true);
  });

  test("an unknown member count is treated as non-idle", () => {
    expect(shouldIdleDisconnect(false, null)).toBe(false);
  });
});

describe("startBlocker", () => {
  test("an existing track is never blocked", () => {
    expect(
      startBlocker({ hasCurrent: true, paused: true, coolingDown: true, hasSlot: false }),
    ).toBeNull();
  });

  test("cooldown is reported before busy", () => {
    expect(
      startBlocker({ hasCurrent: false, paused: false, coolingDown: true, hasSlot: false }),
    ).toBe("cooldown");
  });

  test("busy is reported when no stream slot is free", () => {
    expect(
      startBlocker({ hasCurrent: false, paused: false, coolingDown: false, hasSlot: false }),
    ).toBe("busy");
  });

  test("starts are allowed with a free slot", () => {
    expect(
      startBlocker({ hasCurrent: false, paused: false, coolingDown: false, hasSlot: true }),
    ).toBe(null);
  });
});

describe("failureNotice", () => {
  test("produces one message for a whole burst", () => {
    expect(failureNotice(["first", "second"], false)).toBe("first");
    expect(failureNotice(["first", "second"], true)).toBe(
      "Playback stopped after repeated failures: first",
    );
  });

  test("returns null when nothing failed", () => {
    expect(failureNotice([], false)).toBeNull();
  });
});

describe("isSuppressedIdle", () => {
  test("only the resource we stopped on purpose is suppressed", () => {
    const stopped = { id: "a" };
    expect(isSuppressedIdle(stopped, stopped)).toBe(true);
  });

  test("a genuine end of another resource is never swallowed", () => {
    expect(isSuppressedIdle({ id: "b" }, { id: "a" })).toBe(false);
    expect(isSuppressedIdle({ id: "a" }, null)).toBe(false);
    expect(isSuppressedIdle(null, { id: "a" })).toBe(false);
  });
});
