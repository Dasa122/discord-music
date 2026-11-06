import { describe, expect, test } from "bun:test";
import { nextDialogFocusIndex } from "./focus";

describe("nextDialogFocusIndex", () => {
  test("wraps forward from the last element to the first", () => {
    expect(nextDialogFocusIndex({ count: 3, currentIndex: 2, shiftKey: false })).toBe(0);
  });

  test("wraps backward from the first element to the last", () => {
    expect(nextDialogFocusIndex({ count: 3, currentIndex: 0, shiftKey: true })).toBe(2);
  });

  test("leaves inner Tab presses to the browser", () => {
    expect(nextDialogFocusIndex({ count: 3, currentIndex: 1, shiftKey: false })).toBeNull();
    expect(nextDialogFocusIndex({ count: 3, currentIndex: 1, shiftKey: true })).toBeNull();
  });

  test("pulls focus back in when it is outside the dialog", () => {
    expect(nextDialogFocusIndex({ count: 3, currentIndex: -1, shiftKey: false })).toBe(0);
    expect(nextDialogFocusIndex({ count: 3, currentIndex: -1, shiftKey: true })).toBe(2);
  });

  test("does nothing when the dialog has no focusable elements", () => {
    expect(nextDialogFocusIndex({ count: 0, currentIndex: -1, shiftKey: false })).toBeNull();
  });
});
