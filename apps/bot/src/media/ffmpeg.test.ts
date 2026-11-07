import { describe, expect, test } from "bun:test";
import {
  buildAudioFilter,
  buildMeasuredFilter,
  computeGainDb,
  DEFAULT_LOUDNESS_SETTINGS,
  LIMITER_FILTER,
  type LoudnessSettings,
  type PlaybackAudioConfig,
  parseLoudnormJson,
  sanitizeStreamHeaders,
  selectPlaybackFilter,
  toPcmArgs,
  toPcmFromFileArgs,
  toPcmFromUrlArgs,
} from "./ffmpeg.js";

function settings(overrides: Partial<LoudnessSettings> = {}): LoudnessSettings {
  return { ...DEFAULT_LOUDNESS_SETTINGS, ...overrides };
}

function config(overrides: Partial<PlaybackAudioConfig> = {}): PlaybackAudioConfig {
  return { ...DEFAULT_LOUDNESS_SETTINGS, streamFilter: "limiter", ...overrides };
}

const OUTPUT_TAIL = ["-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"];

describe("buildAudioFilter", () => {
  test("loudnorm uses the target loudness, true peak, and LRA defaults", () => {
    expect(buildAudioFilter(settings())).toBe("loudnorm=I=-14:TP=-1:LRA=11");
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
      "loudnorm=I=-14:TP=-1:LRA=11",
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
    expect(toPcmArgs()).toContain("loudnorm=I=-14:TP=-1:LRA=11");
    expect(toPcmFromFileArgs("/cache/track.audio")).toContain("loudnorm=I=-14:TP=-1:LRA=11");
  });
});

describe("volume is not part of the filter", () => {
  test("the filter is identical regardless of /volume and contains no volume token", () => {
    // /volume stays on the AudioResource's inline volume stage; the decoder
    // filter must not bake in a per-guild volume that a later change cannot undo.
    const args = toPcmArgs({ normalization: settings() });
    const filter = args[args.indexOf("-af") + 1];
    expect(filter).toBe("loudnorm=I=-14:TP=-1:LRA=11");
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
    // -25 LUFS to -14 LUFS is +11 dB, and -20 dBTP leaves plenty of headroom.
    expect(computeGainDb(-25, -20, -14, -1, 12)).toBe(11);
  });

  test("the gain is clamped to maxGainDb in both directions", () => {
    expect(computeGainDb(-40, -20, -14, -1, 12)).toBe(12);
    expect(computeGainDb(0, -20, -14, -1, 12)).toBe(-12);
  });

  test("true-peak limiting reduces the gain below the loudness delta", () => {
    // +7 dB would push a -2 dBTP peak to +5; only 1 dB fits under -1.0.
    expect(computeGainDb(-23, -2, -14, -1, 12)).toBe(1);
  });

  test("a hot master is attenuated, not boosted, under the -1.0 dBTP ceiling", () => {
    // The reported case: -8.37 LUFS / +2.65 dBTP needs -5.63 dB to reach -14,
    // and the peak (which allows at most -3.65 dB) is already satisfied by it.
    expect(computeGainDb(-8.37, 2.65, -14, -1, 12)).toBeCloseTo(-5.63, 2);
    // The ceiling only caps a boost: +6 dB wanted, but -1.0 - 2 = -3 dB fits.
    expect(computeGainDb(-20, 2, -14, -1, 12)).toBe(-3);
  });

  test("a track already at the target gets no gain", () => {
    expect(computeGainDb(-14, -10, -14, -1, 12)).toBe(0);
  });
});

describe("buildMeasuredFilter", () => {
  test("formats a fixed gain plus the -1 dBFS limiter", () => {
    expect(buildMeasuredFilter(-3.25)).toBe("volume=-3.25dB,alimiter=limit=0.891:level=false");
    expect(buildMeasuredFilter(0)).toBe("volume=0dB,alimiter=limit=0.891:level=false");
  });

  test("rounds a long measured gain to two decimals", () => {
    expect(buildMeasuredFilter(2.346)).toBe("volume=2.35dB,alimiter=limit=0.891:level=false");
    expect(buildMeasuredFilter(-7.631)).toBe("volume=-7.63dB,alimiter=limit=0.891:level=false");
  });
});

describe("selectPlaybackFilter", () => {
  const configured = "loudnorm=I=-14:TP=-1:LRA=11";

  test("cached with a measurement always uses the measured filter", () => {
    for (const streamFilter of ["limiter", "off", "loudnorm", "dynaudnorm"] as const) {
      expect(
        selectPlaybackFilter({
          source: "cache",
          hasMeasurement: true,
          gainDb: -7.631,
          config: config({ streamFilter }),
        }),
      ).toEqual({
        filter: "volume=-7.63dB,alimiter=limit=0.891:level=false",
        kind: "measured",
        gainDb: -7.631,
      });
    }
  });

  test("a stream uses the stream filter, never a configured one", () => {
    const expected = {
      limiter: "alimiter=limit=0.891:level=false",
      loudnorm: configured,
      dynaudnorm: "dynaudnorm=f=150:g=15:p=0.7",
    } as const;
    for (const [streamFilter, filter] of Object.entries(expected)) {
      expect(
        selectPlaybackFilter({
          source: "stream",
          hasMeasurement: false,
          config: config({ streamFilter: streamFilter as keyof typeof expected }),
        }),
      ).toEqual({ filter, kind: "stream" });
    }
  });

  test("the default stream filter is a limiter and never duck a hot master", () => {
    const selected = selectPlaybackFilter({
      source: "stream",
      hasMeasurement: false,
      config: config(),
    });
    expect(selected.filter).toBe("alimiter=limit=0.891:level=false");
    expect(selected.filter).not.toContain("loudnorm");
  });

  test("stream filter off emits no -af", () => {
    expect(
      selectPlaybackFilter({
        source: "stream",
        hasMeasurement: false,
        config: config({ streamFilter: "off" }),
      }),
    ).toEqual({ filter: null, kind: "off" });
  });

  test("cached without a measurement falls back to AUDIO_NORMALIZE", () => {
    const expected = {
      loudnorm: configured,
      dynaudnorm: "dynaudnorm=f=150:g=15:p=0.7",
    } as const;
    for (const [mode, filter] of Object.entries(expected)) {
      expect(
        selectPlaybackFilter({
          source: "cache",
          hasMeasurement: false,
          // AUDIO_STREAM_FILTER must not leak into the cached fallback.
          config: config({ mode: mode as "loudnorm" | "dynaudnorm", streamFilter: "limiter" }),
        }),
      ).toEqual({ filter, kind: "configured" });
    }
    expect(
      selectPlaybackFilter({
        source: "cache",
        hasMeasurement: false,
        gainDb: null,
        config: config({ mode: "off" }),
      }),
    ).toEqual({ filter: null, kind: "off" });
  });

  test("the loudness mode off wins over every other choice and emits no -af", () => {
    for (const streamFilter of ["limiter", "off", "loudnorm", "dynaudnorm"] as const) {
      expect(
        selectPlaybackFilter({
          source: "cache",
          hasMeasurement: true,
          gainDb: -3,
          config: config({ mode: "off", streamFilter }),
        }),
      ).toEqual({ filter: null, kind: "off" });
      expect(
        selectPlaybackFilter({
          source: "stream",
          hasMeasurement: false,
          config: config({ mode: "off", streamFilter }),
        }),
      ).toEqual({ filter: null, kind: "off" });
    }
  });

  test("a non-finite gain falls back to the configured filter", () => {
    expect(
      selectPlaybackFilter({
        source: "cache",
        hasMeasurement: true,
        gainDb: Number.NaN,
        config: config(),
      }),
    ).toEqual({ filter: configured, kind: "configured" });
  });
});

describe("per-call filter override", () => {
  test("a stream filter of off builds argv with no -af at all", () => {
    const selected = selectPlaybackFilter({
      source: "stream",
      hasMeasurement: false,
      config: config({ streamFilter: "off" }),
    });
    expect(selected.filter).toBeNull();
    for (const args of [
      toPcmArgs({ normalization: settings(), filter: selected.filter }),
      toPcmFromFileArgs("/cache/track.audio", {
        startSec: 10,
        normalization: settings(),
        filter: selected.filter,
      }),
      toPcmFromUrlArgs("https://example.test/a", undefined, {
        normalization: settings(),
        filter: selected.filter,
      }),
    ]) {
      expect(args).not.toContain("-af");
      expect(args).not.toContain("");
    }
  });

  test("the limiter filter is valid ffmpeg argv for a streamed play", () => {
    const selected = selectPlaybackFilter({
      source: "stream",
      hasMeasurement: false,
      config: config(),
    });
    const args = toPcmFromUrlArgs("https://example.test/a", undefined, {
      normalization: settings(),
      filter: selected.filter,
    });
    expect(args[args.indexOf("-af") + 1]).toBe(LIMITER_FILTER);
  });

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

describe("direct stream URL", () => {
  test("sanitizeStreamHeaders joins with CRLF and strips CR/LF from values", () => {
    const block = sanitizeStreamHeaders({
      "User-Agent": "com.google.ios.youtube/20.11.6\r\nX-Injected: 1",
      "X-Other": "line\nbreak\r",
    });

    expect(block).toBe(
      "User-Agent: com.google.ios.youtube/20.11.6X-Injected: 1\r\nX-Other: linebreak",
    );
    expect(block?.split("\r\n")).toHaveLength(2);
  });

  test("sanitizeStreamHeaders also strips CR/LF from a header name and drops empty ones", () => {
    expect(sanitizeStreamHeaders({ "Bad\r\nName": "v" })).toBe("BadName: v");
    expect(sanitizeStreamHeaders({})).toBeNull();
    expect(sanitizeStreamHeaders(undefined)).toBeNull();
  });

  test("toPcmFromUrl puts -headers and -ss before -i and the output tail last", () => {
    const args = toPcmFromUrlArgs(
      "https://rr1.googlevideo.com/videoplayback?itag=140",
      { "User-Agent": "UA" },
      { startSec: 30, normalization: settings() },
    );

    const headers = args.indexOf("-headers");
    const seek = args.indexOf("-ss");
    const input = args.indexOf("-i");

    expect(headers).toBeGreaterThanOrEqual(0);
    expect(args[headers + 1]).toBe("User-Agent: UA");
    expect(seek).toBeGreaterThanOrEqual(0);
    expect(args[seek + 1]).toBe("30");
    expect(headers).toBeLessThan(input);
    expect(seek).toBeLessThan(input);
    expect(input).toBeLessThan(args.indexOf("-af"));
    expect(args.slice(-OUTPUT_TAIL.length)).toEqual(OUTPUT_TAIL);
    expect(args[args.length - 1]).toBe("pipe:1");
  });

  test("toPcmFromUrl emits -ss 0 for the first play and no -headers when absent", () => {
    const args = toPcmFromUrlArgs("https://rr1.googlevideo.com/videoplayback", undefined, {
      normalization: settings({ mode: "off" }),
    });

    expect(args).not.toContain("-headers");
    expect(args[args.indexOf("-ss") + 1]).toBe("0");
    expect(args).not.toContain("-af");
    expect(args.slice(-OUTPUT_TAIL.length)).toEqual(OUTPUT_TAIL);
  });
});
