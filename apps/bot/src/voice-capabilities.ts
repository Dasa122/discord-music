import { logger } from "./logger.js";

/** Optional native modules voice playback depends on. */
export interface VoiceCapabilities {
  /** Discord's mandatory DAVE/E2EE implementation. Without it audio is dropped. */
  dave: boolean;
  /** Native Opus encoder; `prism-media` falls back to `opusscript` without it. */
  opus: boolean;
  /** Pure-JS Opus encoder used as the fallback. */
  opusscript: boolean;
}

export type ModuleLoader = (specifier: string) => Promise<unknown>;

const defaultLoader: ModuleLoader = (specifier) => import(specifier);

async function canLoad(load: ModuleLoader, specifier: string): Promise<boolean> {
  try {
    await load(specifier);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe the native voice modules. Never throws: a missing or broken module is a
 * capability answer, not a startup failure.
 */
export async function detectVoiceCapabilities(
  load: ModuleLoader = defaultLoader,
): Promise<VoiceCapabilities> {
  const [dave, opus, opusscript] = await Promise.all([
    canLoad(load, "@snazzah/davey"),
    canLoad(load, "@discordjs/opus"),
    canLoad(load, "opusscript"),
  ]);
  return { dave, opus, opusscript };
}

export class VoiceCapabilityError extends Error {
  readonly code = "VOICE_DAVE_MISSING";

  constructor() {
    super("Discord requires DAVE/E2EE; audio will be silent. Install @snazzah/davey.");
    this.name = "VoiceCapabilityError";
  }
}

/** Fail fast: without DAVE the bot connects, "plays", and Discord drops the audio. */
export function assertDaveAvailable(capabilities: VoiceCapabilities): void {
  if (!capabilities.dave) throw new VoiceCapabilityError();
}

export function logVoiceCapabilities(capabilities: VoiceCapabilities): void {
  if (capabilities.dave) {
    logger.info("voice_capabilities", { dave: true, opus: capabilities.opus });
  }
  if (!capabilities.opus) {
    logger.warn("voice_opus_missing", {
      fallback: capabilities.opusscript ? "opusscript" : "none",
    });
  }
}
