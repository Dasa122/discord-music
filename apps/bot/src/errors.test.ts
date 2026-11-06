import { describe, expect, test } from "bun:test";
import {
  isTransientPlaybackError,
  MediaError,
  PlayerError,
  userFacingErrorMessage,
} from "./errors.js";

describe("userFacingErrorMessage", () => {
  test("passes through typed player messages", () => {
    expect(userFacingErrorMessage(new PlayerError("NOTHING_PLAYING", "Nothing is playing."))).toBe(
      "Nothing is playing.",
    );
  });

  test("passes through typed media messages", () => {
    expect(userFacingErrorMessage(new MediaError("NOT_FOUND", "No results."))).toBe("No results.");
  });

  test("never leaks raw database or unexpected error text", () => {
    const pgError = new Error(
      'relation "play_history" does not exist: password authentication failed for user "music"',
    );
    const message = userFacingErrorMessage(pgError);
    expect(message).not.toContain("play_history");
    expect(message).not.toContain("password");
    expect(message).toBe("Something went wrong. Please try again.");
  });

  test("handles non-Error throwables", () => {
    expect(userFacingErrorMessage("boom")).toBe("Something went wrong. Please try again.");
  });
});

describe("isTransientPlaybackError", () => {
  test("busy and cooldown are transient", () => {
    expect(isTransientPlaybackError(new PlayerError("PLAYBACK_BUSY", "busy"))).toBe(true);
    expect(isTransientPlaybackError(new PlayerError("COOLDOWN", "cooldown"))).toBe(true);
  });

  test("media and other errors are real failures", () => {
    expect(isTransientPlaybackError(new MediaError("EXTRACTOR_FAILED", "stale"))).toBe(false);
    expect(isTransientPlaybackError(new Error("boom"))).toBe(false);
  });
});
