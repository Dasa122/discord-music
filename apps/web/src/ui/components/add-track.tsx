import { type FormEvent, useId, useState } from "react";
import { playAction } from "../lib/actions";
import { getErrorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import { useGuildAction } from "../lib/queries";
import { LinkIcon } from "./icons";
import { useToast } from "./toast";

type AddTrackProps = {
  guildId: string;
  className?: string;
};

export function AddTrack({ guildId, className }: AddTrackProps) {
  const inputId = useId();
  const errorId = useId();
  const [query, setQuery] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const action = useGuildAction(guildId);
  const { toast } = useToast();

  const errorMessage = validationError ?? (action.error ? getErrorMessage(action.error) : null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      setValidationError("Enter a link or a search term first.");
      return;
    }

    setValidationError(null);
    action.mutate(playAction(trimmed), {
      onSuccess: () => {
        setQuery("");
        toast("Request sent to the bot.", "success");
      },
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className={cn("rounded-xl border border-border bg-surface p-4", className)}
    >
      <label htmlFor={inputId} className="text-sm font-semibold text-text">
        Add to queue
      </label>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Paste a YouTube or direct audio link, or search by title.
      </p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <LinkIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            id={inputId}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (validationError) {
                setValidationError(null);
              }
              if (action.error) {
                action.reset();
              }
            }}
            placeholder="Paste a link or type a title"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errorMessage !== null}
            aria-describedby={errorMessage ? errorId : undefined}
            className="w-full rounded-lg border border-border bg-surface-raised py-2 pr-3 pl-9 text-sm text-text placeholder:text-muted/60 focus:border-accent/60 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={action.isPending}
          className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-background transition-colors hover:bg-accent-strong disabled:opacity-50"
        >
          {action.isPending ? "Sending…" : "Play"}
        </button>
      </div>

      {errorMessage ? (
        <p id={errorId} role="alert" className="mt-2 text-xs leading-relaxed text-danger">
          {errorMessage}
        </p>
      ) : null}
    </form>
  );
}
