import { describe, expect, test } from "bun:test";
import {
  buildAudioFilter,
  buildMeasuredFilter,
  computeGainDb,
  DEFAULT_LOUDNESS_SETTINGS,
  type LoudnessSettings,
  parseLoudnormJson,
  selectPlaybackFilter,
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

const LOUDNORM_STDERR = `ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers
  built with gcc 14.2.0 (Alpine 14.2.0)
  configuration: --enable-libopus
[Parsed_loudnorm_0 @ 0x55f3c1a2b300] 
{
\t"input_i" : "-23.14",
\t"input_tp" : "-4.31",
\t"input_lra" : "7.20",
\t"input_thresh" : "-33.15",
\t"output_i" : "-16.00",
\t"output_tp" : "-1.50",
\t"output_lra" : "7.20",
\t"output_thresh" : "-26.14",
\t"normalization_type" : "dynamic",
\t"target_offset" : "0.00"
}
size=N/A time=00:03:42.11 bitrate=N/A speed= 420x
[out#0/null @ 0x55f3c1a2b500] video:0kB audio:19201kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: unknown`;

describe("parseLoudnormJson", () => {
  test("extracts the measured figures from a realistic stderr blob", () => {
    expect(parseLoudnormJson(LOUDNORM_STDERR)).toEqual({
      inputLufs: -23.14,
      inputTp: -4.31,
      inputLra: 7.2,
      inputThresh: -33.15,
    });
  });

  test("a silent input (-inf) is not a usable measurement", () => {
    expect(
      parseLoudnormJson(
        '{"input_i":"-inf","input_tp":"-inf","input_lra":"0.00","input_thresh":"-inf"}',
      ),
    ).toBeNull();
  });

  test("missing keys make the block unusable", () => {
    expect(
      parseLoudnormJson('{"input_i":"-23.14","input_tp":"-4.31","input_lra":"7.20"}'),
    ).toBeNull();
  });

  test("malformed JSON and absent JSON both return null", () => {
    expect(parseLoudnormJson('{"input_i": "-23.14", broken}')).toBeNull();
    expect(parseLoudnormJson("size=N/A time=00:00:01.00 bitrate=N/A")).toBeNull();
    expect(parseLoudnormJson("")).toBeNull();
  });

  test("ignores an earlier JSON object and uses the trailing one", () => {
    const stderr = `{"input_i":"-99"}\n${LOUDNORM_STDERR}`;
    expect(parseLoudnormJson(stderr)?.inputLufs).toBe(-23.14);
  });
});

describe("computeGainDb", () => {
  test("a normal track gets target - input", () => {
    // -25 LUFS to -16 LUFS is +9 dB, and -20 dBTP leaves plenty of headroom.
    expect(computeGainDb(-25, -20, -16, -1.5, 12)).toBe(9);
  });

  test("the gain is clamped to maxGainDb in both directions", () => {
    expect(computeGainDb(-40, -20, -16, -1.5, 12)).toBe(12);
    expect(computeGainDb(0, -20, -16, -1.5, 12)).toBe(-12);
  });

  test("true-peak limiting reduces the gain below the loudness delta", () => {
    // +7 dB would push a -2 dBTP peak to +5; only 0.5 dB fits under -1.5.
    expect(computeGainDb(-23, -2, -16, -1.5, 12)).toBe(0.5);
  });

  test("a track already at the target gets no gain", () => {
    expect(computeGainDb(-16, -10, -16, -1.5, 12)).toBe(0);
  });
});

describe("buildMeasuredFilter", () => {
  test("formats a fixed gain plus the -1 dBFS limiter", () => {
    expect(buildMeasuredFilter(-3.25)).toBe("volume=-3.25dB,alimiter=limit=0.891:level=false");
    expect(buildMeasuredFilter(0)).toBe("volume=0dB,alimiter=limit=0.891:level=false");
  });

  test("rounds a long measured gain to two decimals", () => {
    expect(buildMeasuredFilter(2.346)).toBe("volume=2.35dB,alimiter=limit=0.891:level=false");
  });
});

describe("selectPlaybackFilter", () => {
  const configured = "loudnorm=I=-16:TP=-1.5:LRA=11";

  test("cached with a measured gain uses that exact gain", () => {
    expect(selectPlaybackFilter({ source: "cache", settings: settings(), gainDb: -3.21 })).toEqual({
      filter: buildMeasuredFilter(-3.21),
      kind: "measured",
      gainDb: -3.21,
    });
  });

  test("cached without a measurement keeps the configured filter", () => {
    expect(selectPlaybackFilter({ source: "cache", settings: settings() })).toEqual({
      filter: configured,
      kind: "configured",
    });
    expect(selectPlaybackFilter({ source: "cache", settings: settings(), gainDb: null })).toEqual({
      filter: configured,
      kind: "configured",
    });
  });

  test("dynaudnorm is still the configured filter for an unmeasured cached track", () => {
    expect(
      selectPlaybackFilter({ source: "cache", settings: settings({ mode: "dynaudnorm" }) }),
    ).toEqual({ filter: "dynaudnorm=f=150:g=15:p=0.7", kind: "configured" });
  });

  test("a stream always uses the configured filter, even with a gain", () => {
    expect(selectPlaybackFilter({ source: "stream", settings: settings(), gainDb: 5 })).toEqual({
      filter: configured,
      kind: "configured",
    });
  });

  test("off wins over a measured gain and emits no filter", () => {
    expect(
      selectPlaybackFilter({ source: "cache", settings: settings({ mode: "off" }), gainDb: -3 }),
    ).toEqual({ filter: null, kind: "off" });
    expect(selectPlaybackFilter({ source: "stream", settings: settings({ mode: "off" }) })).toEqual(
      {
        filter: null,
        kind: "off",
      },
    );
  });

  test("a non-finite gain falls back to the configured filter", () => {
    expect(
      selectPlaybackFilter({ source: "cache", settings: settings(), gainDb: Number.NaN }),
    ).toEqual({ filter: configured, kind: "configured" });
  });
});

describe("per-call filter override", () => {
  test("the measured filter replaces the configured one on both argv builders", () => {
    const measured = buildMeasuredFilter(4.5);
    for (const args of [
      toPcmArgs({ normalization: settings(), filter: measured }),
      toPcmFromFileArgs("/cache/track.audio", { normalization: settings(), filter: measured }),
    ]) {
      expect(args[args.indexOf("-af") + 1]).toBe(measured);
      expect(args.slice(-OUTPUT_TAIL.length)).toEqual(OUTPUT_TAIL);
    }
  });

  test("a null override emits no -af even with normalization configured", () => {
    for (const args of [
      toPcmArgs({ normalization: settings(), filter: null }),
      toPcmFromFileArgs("/cache/track.audio", { normalization: settings(), filter: null }),
    ]) {
      expect(args).not.toContain("-af");
      expect(args.slice(-OUTPUT_TAIL.length)).toEqual(OUTPUT_TAIL);
    }
  });
});
