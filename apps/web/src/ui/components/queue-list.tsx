import type { QueueTrack } from "@music/shared";
import type { ReactNode } from "react";
import { moveAction, removeAction } from "../lib/actions";
import { cn } from "../lib/cn";
import { formatDuration } from "../lib/format";
import { useGuildAction } from "../lib/queries";
import { EmptyState } from "./empty-state";
import { ErrorBanner } from "./error-banner";
import { ChevronDownIcon, ChevronUpIcon, ListIcon, MusicIcon, XIcon } from "./icons";

type QueueListProps = {
  guildId: string;
  queue: QueueTrack[];
  compact?: boolean;
  limit?: number;
  emptyDescription?: string;
};

function RowButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted transition-colors hover:bg-white/5 hover:text-text disabled:opacity-30"
    >
      {children}
    </button>
  );
}

export function QueueList({
  guildId,
  queue,
  compact = false,
  limit,
  emptyDescription,
}: QueueListProps) {
  const action = useGuildAction(guildId);

  if (queue.length === 0) {
    return (
      <EmptyState
        icon={<ListIcon className="h-5 w-5" />}
        title="Queue is empty"
        description={emptyDescription ?? "Add a track from the dashboard to start queuing music."}
        className="border-0"
      />
    );
  }

  const knownTotal = queue.reduce((total, track) => total + (track.durationSec ?? 0), 0);
  const unknownDurations = queue.filter((track) => track.durationSec === null).length;
  const totalLabel =
    knownTotal > 0 ? `${formatDuration(knownTotal)}${unknownDurations > 0 ? "+" : ""}` : "—";
  const visibleTracks = limit === undefined ? queue : queue.slice(0, limit);

  return (
    <div>
      <ol className="divide-y divide-border">
        {visibleTracks.map((track, index) => (
          <li
            key={track.id}
            className={cn(
              "flex items-center gap-3 px-3 py-2.5 sm:px-4",
              action.isPending && "opacity-70",
            )}
          >
            <span className="w-5 shrink-0 text-right text-xs text-muted tabular-nums">
              {index + 1}
            </span>

            {!compact ? (
              <span className="hidden h-9 w-14 shrink-0 overflow-hidden rounded-md border border-border bg-surface-raised sm:flex sm:items-center sm:justify-center">
                {track.thumbnailUrl ? (
                  <img
                    src={track.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <MusicIcon className="h-4 w-4 text-muted" />
                )}
              </span>
            ) : null}

            <div className="min-w-0 flex-1">
              <a
                href={track.url}
                target="_blank"
                rel="noreferrer noopener"
                className="block truncate text-sm font-medium text-text underline-offset-4 hover:text-accent-strong hover:underline"
              >
                {track.title}
              </a>
              <p className="mt-0.5 truncate text-xs text-muted">
                {track.requestedBy.name}
                <span className="sm:hidden"> · {formatDuration(track.durationSec)}</span>
              </p>
            </div>

            <span className="hidden shrink-0 text-xs text-muted tabular-nums sm:block">
              {formatDuration(track.durationSec)}
            </span>

            {!compact ? (
              <div className="flex shrink-0 items-center gap-1">
                <RowButton
                  label={`Move ${track.title} up`}
                  onClick={() => action.mutate(moveAction(index, index - 1))}
                  disabled={action.isPending || index === 0}
                >
                  <ChevronUpIcon className="h-3.5 w-3.5" />
                </RowButton>
                <RowButton
                  label={`Move ${track.title} down`}
                  onClick={() => action.mutate(moveAction(index, index + 1))}
                  disabled={action.isPending || index === queue.length - 1}
                >
                  <ChevronDownIcon className="h-3.5 w-3.5" />
                </RowButton>
                <RowButton
                  label={`Remove ${track.title} from the queue`}
                  onClick={() => action.mutate(removeAction(index))}
                  disabled={action.isPending}
                >
                  <XIcon className="h-3.5 w-3.5" />
                </RowButton>
              </div>
            ) : null}
          </li>
        ))}
      </ol>

      <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted sm:px-4">
        <span>
          {queue.length} {queue.length === 1 ? "track" : "tracks"}
          {unknownDurations > 0 ? " · some durations unknown" : ""}
        </span>
        <span className="tabular-nums">{totalLabel}</span>
      </div>

      {action.error ? (
        <div className="border-t border-border p-3">
          <ErrorBanner
            error={action.error}
            title="Queue update failed"
            onDismiss={() => action.reset()}
          />
        </div>
      ) : null}
    </div>
  );
}
