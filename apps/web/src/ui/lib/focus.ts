/**
 * Focus helpers for modal dialogs.
 *
 * Kept free of DOM access so the Tab-cycling decision is unit-testable.
 */

/** Elements inside a dialog that participate in the Tab order. */
export const DIALOG_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Index to move focus to when Tab is pressed inside a dialog, or null to let
 * the browser advance focus normally.
 */
export function nextDialogFocusIndex(input: {
  count: number;
  currentIndex: number;
  shiftKey: boolean;
}): number | null {
  const { count, currentIndex, shiftKey } = input;
  if (count <= 0) return null;

  if (currentIndex < 0 || currentIndex >= count) {
    return shiftKey ? count - 1 : 0;
  }
  if (shiftKey && currentIndex === 0) return count - 1;
  if (!shiftKey && currentIndex === count - 1) return 0;
  return null;
}
