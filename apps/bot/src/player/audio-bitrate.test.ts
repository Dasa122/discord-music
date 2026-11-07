import { describe, expect, test } from "bun:test";
import {
  applyEncoderBitrate,
  OPUS_SET_BITRATE_REQUEST,
  resolveEffectiveBitrateKbps,
} from "./audio-bitrate.js";

describe("resolveEffectiveBitrateKbps", () => {
  test("keeps the requested bitrate when the channel is wider", () => {
    expect(resolveEffectiveBitrateKbps(96, 128_000)).toBe(96);
    expect(resolveEffectiveBitrateKbps(96)).toBe(96);
  });

  test("caps the request at the channel's bitrate", () => {
    expect(resolveEffectiveBitrateKbps(96, 64_000)).toBe(64);
    expect(resolveEffectiveBitrateKbps(128, 96_000)).toBe(96);
  });

  test("falls back to the request when the channel bitrate is unknown", () => {
    expect(resolveEffectiveBitrateKbps(96, undefined)).toBe(96);
    expect(resolveEffectiveBitrateKbps(96, 0)).toBe(96);
  });

  test("applies Discord's 8 kbps floor", () => {
    expect(resolveEffectiveBitrateKbps(4, 256_000)).toBe(8);
    expect(resolveEffectiveBitrateKbps(96, 6_000)).toBe(8);
  });

  test("applies the encoder's 128 kbps ceiling", () => {
    expect(resolveEffectiveBitrateKbps(512, 512_000)).toBe(128);
    expect(resolveEffectiveBitrateKbps(256, 384_000)).toBe(128);
    expect(resolveEffectiveBitrateKbps(128, 384_000)).toBe(128);
  });
});

describe("applyEncoderBitrate", () => {
  test("uses setBitrate with bits per second", () => {
    const calls: number[] = [];
    const result = applyEncoderBitrate({ setBitrate: (bps: number) => calls.push(bps) }, 96);

    expect(result).toEqual({ applied: true, method: "setBitrate" });
    expect(calls).toEqual([96_000]);
  });

  test("falls back to OPUS_SET_BITRATE through applyEncoderCTL", () => {
    const calls: Array<[number, number]> = [];
    const result = applyEncoderBitrate(
      { applyEncoderCTL: (request: number, value: number) => calls.push([request, value]) },
      96,
    );

    expect(result).toEqual({ applied: true, method: "applyEncoderCTL" });
    expect(calls).toEqual([[OPUS_SET_BITRATE_REQUEST, 96_000]]);
    expect(OPUS_SET_BITRATE_REQUEST).toBe(4002);
  });

  test("tolerates an encoder with no bitrate control", () => {
    expect(applyEncoderBitrate({}, 96)).toEqual({ applied: false, method: "unsupported" });
    expect(applyEncoderBitrate(null, 96)).toEqual({ applied: false, method: "unsupported" });
  });

  test("never throws when the encoder rejects the control", () => {
    expect(
      applyEncoderBitrate(
        {
          setBitrate: () => {
            throw new Error("no CTL support");
          },
        },
        96,
      ),
    ).toEqual({ applied: false, method: "error" });
  });
});
