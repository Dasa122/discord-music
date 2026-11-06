import { describe, expect, test } from "bun:test";
import { clamp, formatDuration, formatNumber, formatRelativeTime } from "./format";

describe("formatDuration", () => {
  const cases: Array<[number | null, string]> = [
    [null, "—"],
    [0, "0:00"],
    [59, "0:59"],
    [60, "1:00"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [7325, "2:02:05"],
    [-5, "—"],
    [Number.NaN, "—"],
  ];

  for (const [input, expected] of cases) {
    test(`formats ${String(input)} as ${expected}`, () => {
      expect(formatDuration(input)).toBe(expected);
    });
  }

  test("floors fractional seconds", () => {
    expect(formatDuration(59.9)).toBe("0:59");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-11-06T12:00:00.000Z");
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();

  test("treats the last minute as just now", () => {
    expect(formatRelativeTime(at(10), now)).toBe("just now");
    expect(formatRelativeTime(at(59), now)).toBe("just now");
  });

  test("reports minutes and hours", () => {
    expect(formatRelativeTime(at(60), now)).toBe("1 minute ago");
    expect(formatRelativeTime(at(5 * 60), now)).toBe("5 minutes ago");
    expect(formatRelativeTime(at(2 * 3600), now)).toBe("2 hours ago");
  });

  test("reports days, months, and years", () => {
    expect(formatRelativeTime(at(24 * 3600), now)).toBe("yesterday");
    expect(formatRelativeTime(at(5 * 24 * 3600), now)).toBe("5 days ago");
    expect(formatRelativeTime(at(45 * 24 * 3600), now)).toBe("1 month ago");
    expect(formatRelativeTime(at(400 * 24 * 3600), now)).toBe("1 year ago");
  });

  test("accepts a Date for now and handles future timestamps", () => {
    expect(formatRelativeTime(at(-10), new Date(now))).toBe("just now");
  });

  test("returns an em dash for invalid input", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("—");
  });
});

describe("formatNumber", () => {
  test("groups thousands with en-US separators", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(1234)).toBe("1,234");
    expect(formatNumber(1_000_000)).toBe("1,000,000");
  });

  test("returns an em dash for non-finite input", () => {
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("clamp", () => {
  test("constrains values to the inclusive range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
