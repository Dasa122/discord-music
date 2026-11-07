import { describe, expect, test } from "bun:test";
import {
  assertDaveAvailable,
  detectVoiceCapabilities,
  type ModuleLoader,
  VoiceCapabilityError,
} from "./voice-capabilities.js";

/** Pretend only the given specifiers are installed; everything else 404s. */
function loaderWith(installed: string[]): ModuleLoader {
  return async (specifier: string) => {
    if (installed.includes(specifier)) return { default: {} };
    throw Object.assign(new Error(`Cannot find module '${specifier}'`), {
      code: "MODULE_NOT_FOUND",
    });
  };
}

describe("detectVoiceCapabilities", () => {
  test("reports both native modules when they load", async () => {
    const capabilities = await detectVoiceCapabilities(
      loaderWith(["@snazzah/davey", "@discordjs/opus", "opusscript"]),
    );
    expect(capabilities).toEqual({ dave: true, opus: true, opusscript: true });
  });

  test("reports a missing DAVE library", async () => {
    const capabilities = await detectVoiceCapabilities(
      loaderWith(["@discordjs/opus", "opusscript"]),
    );
    expect(capabilities).toEqual({ dave: false, opus: true, opusscript: true });
  });

  test("reports a missing Opus encoder and keeps the opusscript fallback", async () => {
    const capabilities = await detectVoiceCapabilities(
      loaderWith(["@snazzah/davey", "opusscript"]),
    );
    expect(capabilities).toEqual({ dave: true, opus: false, opusscript: true });
  });

  test("never throws when every module is missing", async () => {
    const capabilities = await detectVoiceCapabilities(loaderWith([]));
    expect(capabilities).toEqual({ dave: false, opus: false, opusscript: false });
  });
});

describe("assertDaveAvailable", () => {
  test("throws with an actionable hint when DAVE is missing", () => {
    expect(() => assertDaveAvailable({ dave: false, opus: true, opusscript: true })).toThrow(
      VoiceCapabilityError,
    );
    expect(() => assertDaveAvailable({ dave: false, opus: true, opusscript: true })).toThrow(
      "Install @snazzah/davey",
    );
  });

  test("passes when DAVE is available, even without native Opus", () => {
    expect(() => assertDaveAvailable({ dave: true, opus: false, opusscript: true })).not.toThrow();
  });
});
