import { type ReactNode, useEffect, useId, useRef } from "react";
import { cn } from "../lib/cn";
import { DIALOG_FOCUSABLE_SELECTOR, nextDialogFocusIndex } from "../lib/focus";
import { XIcon } from "./icons";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Keyboard-operable confirmation dialog. Escape cancels; focus stays on the
 * safe action and is restored (and Tab trapped) when the dialog closes.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);

  // Callers pass an inline callback; keeping it in a ref stops the focus
  // effect below from re-running (and stealing focus) on every parent render.
  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    if (!open) {
      const previous = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      previous?.focus();
      return;
    }

    if (!previouslyFocusedRef.current && document.activeElement instanceof HTMLElement) {
      previouslyFocusedRef.current = document.activeElement;
    }
    cancelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key === "Tab") {
        const container = dialogRef.current;
        if (!container) return;
        const focusable = Array.from(
          container.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
        );
        const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
        const next = nextDialogFocusIndex({
          count: focusable.length,
          currentIndex,
          shiftKey: event.shiftKey,
        });
        if (next !== null) {
          event.preventDefault();
          focusable[next]?.focus();
        }
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, pending]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close dialog"
        onClick={onCancel}
        disabled={pending}
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className="relative w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-xl shadow-black/30"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-base font-semibold text-text">
            {title}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            aria-label="Close dialog"
            className="rounded-md p-1 text-muted transition-colors hover:bg-white/5 hover:text-text disabled:opacity-50"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {description ? (
          <div id={descriptionId} className="mt-2 text-sm leading-relaxed text-muted">
            {description}
          </div>
        ) : null}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-text transition-colors hover:bg-white/5 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className={cn(
              "rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors disabled:opacity-50",
              destructive
                ? "bg-danger text-background hover:bg-danger/90"
                : "bg-accent text-background hover:bg-accent-strong",
            )}
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
