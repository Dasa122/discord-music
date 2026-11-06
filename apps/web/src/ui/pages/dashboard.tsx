import type { GuildSummary } from "@music/shared";
import { Link } from "react-router-dom";
import { AddTrack } from "../components/add-track";
import { Badge } from "../components/badge";
import { EmptyState } from "../components/empty-state";
import { ErrorBanner } from "../components/error-banner";
import { GuildGuard } from "../components/guild-guard";
import { ChevronRightIcon } from "../components/icons";
import { NowPlaying } from "../components/now-playing";
import { QueueList } from "../components/queue-list";
import { Skeleton } from "../components/skeleton";
import { formatNumber } from "../lib/format";
import { withGuild } from "../lib/guild-selection";
import { usePlayerState } from "../lib/queries";
import { useGuildSelection } from "../lib/use-guild-selection";

export function DashboardPage() {
  const { guildId } = useGuildSelection();

  return <GuildGuard guildId={guildId}>{(guild) => <DashboardContent guild={guild} />}</GuildGuard>;
}

function DashboardContent({ guild }: { guild: GuildSummary }) {
  const { data: state, isLoading, isError, error, refetch } = usePlayerState(guild.id);
  const queue = state?.queue ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Server</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-text">{guild.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {formatNumber(guild.memberCount)} members
            {guild.connected ? " · bot connected to voice" : " · bot not in voice"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={guild.connected ? "success" : "neutral"}>
            {guild.connected ? "Connected" : "Bot offline"}
          </Badge>
          {guild.playing && guild.currentTitle ? (
            <Badge variant="accent" className="max-w-64">
              <span className="truncate">{guild.currentTitle}</span>
            </Badge>
          ) : null}
        </div>
      </header>

      {isError ? (
        <ErrorBanner
          error={error}
          title="Could not load player state"
          onRetry={() => {
            void refetch();
          }}
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {isLoading && !state ? (
            <Skeleton className="h-64 w-full rounded-xl" />
          ) : state ? (
            <NowPlaying guildId={guild.id} state={state} />
          ) : isError ? (
            <EmptyState
              title="Player state unavailable"
              description="The bot did not report its state. Use Try again above, then pick another server if the problem continues."
              className="h-full"
            />
          ) : (
            <Skeleton className="h-64 w-full rounded-xl" />
          )}
        </div>
        <AddTrack guildId={guild.id} />
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-surface">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="text-sm font-semibold tracking-tight text-text">Up next</h2>
            <span className="text-xs text-muted">
              {queue.length} {queue.length === 1 ? "track" : "tracks"}
            </span>
          </div>
          <Link
            to={withGuild("/queue", guild.id)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10"
          >
            Open queue
            <ChevronRightIcon className="h-3.5 w-3.5" />
          </Link>
        </header>

        {isLoading && !state ? (
          <div className="space-y-px p-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : isError && !state ? (
          <EmptyState
            title="Queue unavailable"
            description="The bot did not return the queue. Retry above to reconnect to it."
            className="border-0"
          />
        ) : (
          <QueueList
            guildId={guild.id}
            queue={queue}
            compact
            limit={10}
            emptyDescription="Nothing is queued. Add a track above to start playing."
          />
        )}

        {queue.length > 10 ? (
          <div className="border-t border-border px-4 py-2 text-xs text-muted">
            Showing 10 of {queue.length} tracks.{" "}
            <Link
              to={withGuild("/queue", guild.id)}
              className="font-medium text-accent underline-offset-4 hover:underline"
            >
              See the full queue
            </Link>
          </div>
        ) : null}
      </section>
    </div>
  );
}
