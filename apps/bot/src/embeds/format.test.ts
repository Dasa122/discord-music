import { describe, expect, test } from "bun:test";
import { capitalize, escapeMarkdown, formatDuration, truncate } from "./format.js";

describe("escapeMarkdown", () => {
  test("defuses masked links", () => {
    expect(escapeMarkdown("[click](https://evil.example)")).toBe(
      "\\[click\\](https://evil.example)",
    );
  });

  test("escapes inline formatting characters", () => {
    expect(escapeMarkdown("*bold* _it_ ~strike~ | `code` > quote")).toBe(
      "\\*bold\\* \\_it\\_ \\~strike\\~ \\| \\`code\\` \\> quote",
    );
  });

  test("escapes a backslash once", () => {
    expect(escapeMarkdown("a\\b")).toBe("a\\\\b");
  });

  test("leaves ordinary titles untouched", () => {
    expect(escapeMarkdown("Never Gonna Give You Up")).toBe("Never Gonna Give You Up");
    expect(escapeMarkdown("Song - Artist (Remix)")).toBe("Song - Artist (Remix)");
  });
});

describe("formatDuration", () => {
  test("formats minutes, hours, and unknown durations", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3_725)).toBe("1:02:05");
    expect(formatDuration(null)).toBe("Live / unknown");
  });
});

describe("truncate and capitalize", () => {
  test("truncate adds an ellipsis only when needed", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("abcd", 3)).toBe("ab…");
  });

  test("capitalize handles the empty string", () => {
    expect(capitalize("")).toBe("");
    expect(capitalize("queue")).toBe("Queue");
  });
});
