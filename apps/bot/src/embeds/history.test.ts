import { describe, expect, test } from "bun:test";
import { clampHistoryPage, MAX_HISTORY_PAGE } from "./history.js";

describe("clampHistoryPage", () => {
  test("clamps to the maximum page", () => {
    expect(clampHistoryPage(5000)).toBe(MAX_HISTORY_PAGE);
  });

  test("clamps to page one", () => {
    expect(clampHistoryPage(0)).toBe(1);
    expect(clampHistoryPage(-3)).toBe(1);
  });

  test("non-finite input falls back to page one", () => {
    expect(clampHistoryPage(Number.NaN)).toBe(1);
  });

  test("valid pages pass through", () => {
    expect(clampHistoryPage(4)).toBe(4);
  });
});
