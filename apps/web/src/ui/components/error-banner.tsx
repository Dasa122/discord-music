import { getErrorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import { AlertTriangleIcon, XIcon } from "./icons";

type ErrorBannerProps = {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  className?: string;
};

export function ErrorBanner({
  error,
  title = "Something went wrong",
  onRetry,
  onDismiss,
  className,
}: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm",
        className,
      )}
    >
      <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-danger">{title}</p>
        <p className="mt-0.5 leading-relaxed text-muted">{getErrorMessage(error)}</p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 rounded-lg border border-danger/30 px-2.5 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
          >
            Try again
          </button>
        ) : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss error"
          className="rounded-md p-1 text-muted transition-colors hover:bg-white/5 hover:text-text"
        >
          <XIcon className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
