import { describe, expect, test } from "bun:test";
import { MediaError, PlayerError } from "../errors.js";
import { mapControlError } from "./errors.js";

describe("mapControlError", () => {
  test("maps PLAYBACK_BUSY to a 409 conflict", () => {
    const mapped = mapControlError(
      new PlayerError("PLAYBACK_BUSY", "All stream slots are in use."),
    );
    expect(mapped.status).toBe(409);
    expect(mapped.body.ok).toBe(false);
    expect(mapped.body.error.code).toBe("PLAYBACK_BUSY");
  });

  test("maps cooldown and not-connected to 409", () => {
    expect(mapControlError(new PlayerError("COOLDOWN", "cooldown")).status).toBe(409);
    expect(mapControlError(new PlayerError("NOT_CONNECTED", "offline")).status).toBe(409);
  });

  test("maps a missing guild to 404", () => {
    const mapped = mapControlError(new PlayerError("GUILD_NOT_FOUND", "not here"));
    expect(mapped.status).toBe(404);
  });

  test("maps media errors to 400 with the typed code", () => {
    const mapped = mapControlError(
      new MediaError("EXTRACTOR_FAILED", "extractor is stale", "stderr"),
    );
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe("EXTRACTOR_FAILED");
  });

  test("maps unexpected errors to an opaque 500", () => {
    const mapped = mapControlError(new Error("boom"));
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.code).toBe("INTERNAL_ERROR");
    expect(mapped.body.error.message).not.toContain("boom");
  });
});
