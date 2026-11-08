import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TRUNCATION_RATIO,
  isStreamTruncated,
  MAX_TRUNCATION_RECOVERIES,
  planTruncationRecovery,
} from "./stream-truncation.js";

describe("isStreamTruncated", () => {
  test("a stream that stops well before its duration is truncated", () => {
    expect(isStreamTruncated({ positionSec: 67, durationSec: 300 })).toBe(true);
    expect(isStreamTruncated({ positionSec: 269, durationSec: 300 })).toBe(true);
  });

  test("exactly the ratio boundary counts as finished", () => {
    // 90 s of 100 s is exactly 0.9: the track ended, it was not cut short.
    expect(isStreamTruncated({ positionSec: 90, durationSec: 100 })).toBe(false);
    expect(isStreamTruncated({ positionSec: 270, durationSec: 300 })).toBe(false);
    expect(isStreamTruncated({ positionSec: 90.1, durationSec: 100 })).toBe(false);
  });

  test("a track that reaches its duration is never truncated", () => {
    expect(isStreamTruncated({ positionSec: 300, durationSec: 300 })).toBe(false);
  });

  test("live and duration-less tracks are never truncated", () => {
    expect(isStreamTruncated({ positionSec: 1, durationSec: null })).toBe(false);
    expect(isStreamTruncated({ positionSec: 1, durationSec: undefined })).toBe(false);
    expect(isStreamTruncated({ positionSec: 1, durationSec: 0 })).toBe(false);
    expect(isStreamTruncated({ positionSec: 1, durationSec: Number.NaN })).toBe(false);
    expect(isStreamTruncated({ positionSec: 1, durationSec: 300, isLive: true })).toBe(false);
  });

  test("a custom ratio moves the boundary", () => {
    expect(isStreamTruncated({ positionSec: 149, durationSec: 300, ratio: 0.5 })).toBe(true);
    expect(isStreamTruncated({ positionSec: 150, durationSec: 300, ratio: 0.5 })).toBe(false);
    expect(isStreamTruncated({ positionSec: 299, durationSec: 300, ratio: 1 })).toBe(true);
    expect(isStreamTruncated({ positionSec: 300, durationSec: 300, ratio: 1 })).toBe(false);
  });

  test("a non-finite position cannot be classified", () => {
    expect(isStreamTruncated({ positionSec: Number.NaN, durationSec: 300 })).toBe(false);
  });

  test("the default ratio is 0.9 and two recoveries are allowed", () => {
    expect(DEFAULT_TRUNCATION_RATIO).toBe(0.9);
    expect(MAX_TRUNCATION_RECOVERIES).toBe(2);
  });
});

describe("planTruncationRecovery", () => {
  const base = {
    positionSec: 67.9,
    durationSec: 300,
    hasCache: false,
    hasUrl: false,
    recoveries: 0,
  };

  test("prefers the complete cache, then a fresh URL, then yt-dlp", () => {
    expect(planTruncationRecovery({ ...base, hasCache: true, hasUrl: true })).toEqual({
      action: "resume-cache",
      startSec: 67,
    });
    expect(planTruncationRecovery({ ...base, hasUrl: true })).toEqual({
      action: "retry-url",
      startSec: 67,
    });
    expect(planTruncationRecovery(base)).toEqual({ action: "resume-ytdlp", startSec: 67 });
  });

  test("one recovery already spent still allows the same ordered choice", () => {
    expect(
      planTruncationRecovery({ ...base, recoveries: 1, hasCache: true, hasUrl: true }),
    ).toEqual({ action: "resume-cache", startSec: 67 });
    expect(planTruncationRecovery({ ...base, recoveries: 1, hasUrl: true })).toEqual({
      action: "retry-url",
      startSec: 67,
    });
    expect(planTruncationRecovery({ ...base, recoveries: 1 })).toEqual({
      action: "resume-ytdlp",
      startSec: 67,
    });
  });

  test("two recoveries already spent always advance", () => {
    expect(
      planTruncationRecovery({ ...base, recoveries: 2, hasCache: true, hasUrl: true }),
    ).toEqual({ action: "advance", startSec: 0 });
    expect(planTruncationRecovery({ ...base, recoveries: 2, hasUrl: true })).toEqual({
      action: "advance",
      startSec: 0,
    });
    expect(planTruncationRecovery({ ...base, recoveries: 2 })).toEqual({
      action: "advance",
      startSec: 0,
    });
  });

  test("no usable duration means there is nothing to resume", () => {
    expect(planTruncationRecovery({ ...base, durationSec: null, hasCache: true })).toEqual({
      action: "advance",
      startSec: 0,
    });
    expect(planTruncationRecovery({ ...base, durationSec: 0, hasUrl: true })).toEqual({
      action: "advance",
      startSec: 0,
    });
    expect(planTruncationRecovery({ ...base, positionSec: Number.NaN, hasUrl: true })).toEqual({
      action: "advance",
      startSec: 0,
    });
  });

  test("the start offset is floored and clamped inside the track", () => {
    expect(planTruncationRecovery({ ...base, positionSec: 0.4, hasUrl: true }).startSec).toBe(0);
    expect(planTruncationRecovery({ ...base, positionSec: 299.9, hasUrl: true }).startSec).toBe(
      299,
    );
    expect(
      planTruncationRecovery({ ...base, positionSec: 900, durationSec: 300, hasUrl: true }),
    ).toEqual({ action: "advance", startSec: 0 });
  });

  test("the recovery budget is configurable", () => {
    expect(planTruncationRecovery({ ...base, recoveries: 1, maxRecoveries: 1 })).toEqual({
      action: "advance",
      startSec: 0,
    });
  });
});
