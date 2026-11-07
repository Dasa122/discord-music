/**
 * Opus bitrate applied to every outgoing voice stream.
 *
 * Discord encodes PCM internally through a per-resource `prism-media`
 * `opus.Encoder`, exposed publicly as `AudioResource.encoder`. The encoder is
 * created for each `createAudioResource` call, so the bitrate is re-applied on
 * every play, seek and track change.
 */

/** Requested bitrate when `AUDIO_BITRATE_KBPS` is unset. */
export const DEFAULT_AUDIO_BITRATE_KBPS = 96;
/** Discord refuses voice channels below 8 kbps. */
export const MIN_AUDIO_BITRATE_KBPS = 8;
/**
 * Hard ceiling of the outgoing encoder: `prism-media`'s `Opus.setBitrate`
 * clamps to 128 000 bps, so asking for more is a silent no-op.
 */
export const MAX_AUDIO_BITRATE_KBPS = 128;
/** `OPUS_SET_BITRATE` encoder control request id. */
export const OPUS_SET_BITRATE_REQUEST = 4002;

function clampKbps(value: number): number {
  return Math.min(MAX_AUDIO_BITRATE_KBPS, Math.max(MIN_AUDIO_BITRATE_KBPS, Math.trunc(value)));
}

/**
 * The bitrate actually usable in a channel.
 *
 * Order matters: clamp the request to the encoder's 8..128 kbps range first,
 * then apply the channel's cap, then the floor again — a channel below 8 kbps
 * cannot push the result under what Opus accepts, and no channel can raise it
 * above the encoder ceiling.
 */
export function resolveEffectiveBitrateKbps(
  requestedKbps: number,
  channelBitrateBps?: number | null,
): number {
  const requested = clampKbps(
    Number.isFinite(requestedKbps) ? requestedKbps : DEFAULT_AUDIO_BITRATE_KBPS,
  );
  if (
    channelBitrateBps === undefined ||
    channelBitrateBps === null ||
    !Number.isFinite(channelBitrateBps) ||
    channelBitrateBps <= 0
  ) {
    return requested;
  }
  return clampKbps(Math.min(requested, Math.floor(channelBitrateBps / 1000)));
}

export type EncoderBitrateMethod = "setBitrate" | "applyEncoderCTL" | "unsupported" | "error";

export interface EncoderBitrateResult {
  applied: boolean;
  method: EncoderBitrateMethod;
}

interface EncoderControlLike {
  setBitrate?: (bps: number) => void;
  applyEncoderCTL?: (request: number, value: number) => void;
  encoderCTL?: (request: number, value: number) => void;
}

/**
 * Apply a bitrate to whatever the encoder exposes. `setBitrate` is prism-media's
 * public path; `applyEncoderCTL` is the raw `@discordjs/opus` control call.
 * Never throws: a playback start must survive an encoder without bitrate support.
 */
export function applyEncoderBitrate(encoder: unknown, kbps: number): EncoderBitrateResult {
  const bps = Math.round(kbps * 1000);
  if (!encoder || typeof encoder !== "object") {
    return { applied: false, method: "unsupported" };
  }

  const candidate = encoder as EncoderControlLike;
  try {
    if (typeof candidate.setBitrate === "function") {
      candidate.setBitrate(bps);
      return { applied: true, method: "setBitrate" };
    }
    const control = candidate.applyEncoderCTL ?? candidate.encoderCTL;
    if (typeof control === "function") {
      control.call(candidate, OPUS_SET_BITRATE_REQUEST, bps);
      return { applied: true, method: "applyEncoderCTL" };
    }
    return { applied: false, method: "unsupported" };
  } catch {
    return { applied: false, method: "error" };
  }
}
