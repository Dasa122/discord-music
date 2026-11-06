import type { GuildSummary } from "@music/shared";
import { useState } from "react";
import { Badge } from "../components/badge";
import { ConfirmDialog } from "../components/confirm-dialog";
import { EmptyState } from "../components/empty-state";
import { ErrorBanner } from "../components/error-banner";
import { GuildGuard } from "../components/guild-guard";
import { QueueList } from "../components/queue-list";
import { Skeleton } from "../components/skeleton";
import { clearAction } from "../lib/actions";
import { formatDuration } from "../lib/format";
import { useGuildAction, usePlayerState } from "../lib/queries";
import { useGuildSelection } from "../lib/use-guild-selection";

export function QueuePage() {
  const { guildId } = useGuildSelection();

  return <GuildGuard guildId={guildId}>{(guild) => <QueueContent guild={guild} />}</GuildGuard>;
}

function QueueContent({ guild }: { guild: GuildSummary }) {
  const { data: state, isLoading, isError, error, refetch } = usePlayerState(guild.id);
  const action = useGuildAction(guild.id);
  const [confirmClear, setConfirmClear] = useState(false);

  const queue = state?.queue ?? [];
  const totalKnown = queue.reduce((total, track) => total + (track.durationSec ?? 0), 0);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Queue</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-text">{guild.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {queue.length} {queue.length === 1 ? "track" : "tracks"}
            {totalKnown > 0 ? ` · ${formatDuration(totalKnown)}` : ""}
            {state?.connected ? "" : " · bot not in voice"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={state?.connected ? "success" : "neutral"}>
            {state?.connected ? "Connected" : "Disconnected"}
          </Badge>
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            disabled={queue.length === 0 || action.isPending}
            className="rounded-lg border border-danger/30 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
          >
            Clear queue
          </button>
        </div>
      </header>

      {isError ? (
        <ErrorBanner
          error={error}
          title="Could not load the queue"
          onRetry={() => {
            void refetch();
          }}
        />
      ) : null}

      {action.error ? (
        <ErrorBanner
          error={action.error}
          title="Could not update the queue"
          onDismiss={() => action.reset()}
        />
      ) : null}

      <section className="overflow-hidden rounded-xl border border-border bg-surface">
        {isLoading && !state ? (
          <div className="space-y-px p-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : isError && !state ? (
          <EmptyState
            title="Queue unavailable"
            description="The bot did not return the queue. Use Try again above to reconnect."
            className="border-0"
          />
        ) : (
          <QueueList
            guildId={guild.id}
            queue={queue}
            emptyDescription={
              state?.connected
                ? "Nothing is queued. Add a track from the dashboard."
                : "The bot is not connected to voice, so the queue is empty. Join a voice channel and use /play in Discord first."
            }
          />
        )}
      </section>

      <ConfirmDialog
        open={confirmClear}
        title="Clear the queue?"
        description="Every upcoming track is removed. The track that is playing now keeps playing."
        confirmLabel="Clear queue"
        destructive
        pending={action.isPending}
        onConfirm={() => {
          action.mutate(clearAction(), { onSettled: () => setConfirmClear(false) });
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
