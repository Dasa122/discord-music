import { describe, expect, test } from "bun:test";
import {
  buildAudioFilter,
  DEFAULT_LOUDNESS_SETTINGS,
  type LoudnessSettings,
  toPcmArgs,
  toPcmFromFileArgs,
} from "./ffmpeg.js";

function settings(overrides: Partial<LoudnessSettings> = {}): LoudnessSettings {
  return { ...DEFAULT_LOUDNESS_SETTINGS, ...overrides };
}

const OUTPUT_TAIL = ["-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"];

describe("buildAudioFilter", () => {
  test("loudnorm uses the target loudness, true peak, and LRA defaults", () => {
    expect(buildAudioFilter(settings())).toBe("loudnorm=I=-16:TP=-1.5:LRA=11");
  });

  test("loudnorm interpolates every configured value", () => {
    expect(buildAudioFilter(settings({ targetLufs: -23, truePeakDb: -2, lra: 7 }))).toBe(
      "loudnorm=I=-23:TP=-2:LRA=7",
    );
  });

  test("dynaudnorm uses the analysis frame and fixed gain/peak", () => {
    expect(buildAudioFilter(settings({ mode: "dynaudnorm" }))).toBe("dynaudnorm=f=150:g=15:p=0.7");
    expect(buildAudioFilter(settings({ mode: "dynaudnorm", dynFrameMs: 300 }))).toBe(
      "dynaudnorm=f=300:g=15:p=0.7",
    );
  });

  test("off produces no filter at all", () => {
    expect(buildAudioFilter(settings({ mode: "off" }))).toBeNull();
  });
});

describe("ffmpeg arguments", () => {
  test("toPcm puts -af after the input and the output tail last", () => {
    const args = toPcmArgs({ normalization: settings() });
    expect(args).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-af",
      "loudnorm=I=-16:TP=-1.5:LRA=11",
      ...OUTPUT_TAIL,
    ]);
    expect(args.indexOf("-i")).toBeLessThan(args.indexOf("-af"));
    expect(args.slice(-OUTPUT_TAIL.length)).toEqual(OUTPUT_TAIL);
  });

  test("toPcmFromFile keeps an input seek before -i and -af after it", () => {
    const args = toPcmFromFileArgs("/cache/track.audio", {
      startSec: 42,
      normalization: settings({ mode: "dynaudnorm" }),
    });

    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-ss") + 1]).toBe("42");
    expect(args.indexOf("-i")).toBeLessThan(args.indexOf("-af"));
    expect(args[args.indexOf("-af") + 1]).toBe("dynaudnorm=f=150:g=15:p=0.7");
    expect(args.slice(-OUTPUT_TAIL.length)).toEqual(OUTPUT_TAIL);
  });

  test("toPcmFromFile omits -ss when not seeking", () => {
    const args = toPcmFromFileArgs("/cache/track.audio", { normalization: settings() });
    expect(args).not.toContain("-ss");
    expect(args.slice(0, 6)).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "/cache/track.audio",
      "-af",
    ]);
  });

  test("off emits no -af and no empty argument on either path", () => {
    for (const args of [
      toPcmArgs({ normalization: settings({ mode: "off" }) }),
      toPcmFromFileArgs("/cache/track.audio", {
        startSec: 10,
        normalization: settings({ mode: "off" }),
      }),
    ]) {
      expect(args).not.toContain("-af");
      expect(args).not.toContain("");
      expect(args.slice(-OUTPUT_TAIL.length)).toEqual(OUTPUT_TAIL);
    }
  });

  test("omitting settings still normalises with the loudnorm defaults", () => {
    expect(toPcmArgs()).toContain("loudnorm=I=-16:TP=-1.5:LRA=11");
    expect(toPcmFromFileArgs("/cache/track.audio")).toContain("loudnorm=I=-16:TP=-1.5:LRA=11");
  });
});

describe("volume is not part of the filter", () => {
  test("the filter is identical regardless of /volume and contains no volume token", () => {
    // /volume stays on the AudioResource's inline volume stage; the decoder
    // filter must not bake in a per-guild volume that a later change cannot undo.
    const args = toPcmArgs({ normalization: settings() });
    const filter = args[args.indexOf("-af") + 1];
    expect(filter).toBe("loudnorm=I=-16:TP=-1.5:LRA=11");
    expect(filter).not.toContain("volume");
    expect(args.filter((arg) => arg.includes("volume"))).toEqual([]);
  });
});
