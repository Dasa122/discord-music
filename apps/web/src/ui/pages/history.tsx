import type { GuildSummary } from "@music/shared";
import { useSearchParams } from "react-router-dom";
import { EmptyState } from "../components/empty-state";
import { ErrorBanner } from "../components/error-banner";
import { GuildGuard } from "../components/guild-guard";
import { ChevronLeftIcon, ChevronRightIcon, HistoryIcon } from "../components/icons";
import { Skeleton } from "../components/skeleton";
import { cn } from "../lib/cn";
import { formatDuration, formatRelativeTime } from "../lib/format";
import { useHistory } from "../lib/queries";
import { useGuildSelection } from "../lib/use-guild-selection";

const PAGE_SIZE = 25;

export function HistoryPage() {
  const { guildId } = useGuildSelection();

  return <GuildGuard guildId={guildId}>{(guild) => <HistoryContent guild={guild} />}</GuildGuard>;
}

function HistoryContent({ guild }: { guild: GuildSummary }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawPage = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const historyQuery = useHistory(guild.id, page, PAGE_SIZE);
  const items = historyQuery.data?.items ?? [];
  const total = historyQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const start = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const end = Math.min(page * PAGE_SIZE, total);

  const goToPage = (nextPage: number) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (nextPage <= 1) {
        next.delete("page");
      } else {
        next.set("page", String(nextPage));
      }
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-medium tracking-wide text-muted uppercase">Library</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-text">History</h1>
        <p className="mt-1 text-sm text-muted">
          {guild.name} · {total} {total === 1 ? "play" : "plays"} recorded
        </p>
      </header>

      {historyQuery.isError ? (
        <ErrorBanner
          error={historyQuery.error}
          title="Could not load play history"
          onRetry={() => {
            void historyQuery.refetch();
          }}
        />
      ) : null}

      <section className="overflow-hidden rounded-xl border border-border bg-surface">
        {historyQuery.isLoading ? (
          <div className="space-y-px p-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : historyQuery.isError && !historyQuery.data ? null : items.length === 0 ? (
          <EmptyState
            icon={<HistoryIcon className="h-5 w-5" />}
            title={page > 1 ? "No plays on this page" : "No plays yet"}
            description={
              page > 1
                ? "Go back to the previous page to see earlier tracks."
                : "Tracks the bot finishes playing show up here, including who requested them."
            }
            className="border-0"
            action={
              page > 1 ? (
                <button
                  type="button"
                  onClick={() => goToPage(Math.max(1, page - 1))}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text transition-colors hover:bg-white/5"
                >
                  Previous page
                </button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table
                aria-busy={historyQuery.isFetching}
                className={cn(
                  "w-full min-w-[560px] table-fixed border-collapse text-left text-sm",
                  historyQuery.isFetching && "opacity-60",
                )}
              >
                <colgroup>
                  <col className="w-[50%]" />
                  <col className="w-[20%]" />
                  <col className="w-[18%]" />
                  <col className="w-[12%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-border text-xs tracking-wide text-muted uppercase">
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Track
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Requested by
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Played
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">
                      Duration
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((item) => (
                    <tr key={item.id} className="transition-colors hover:bg-white/[0.02]">
                      <td className="px-4 py-3">
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="block truncate font-medium text-text underline-offset-4 hover:text-accent-strong hover:underline"
                        >
                          {item.title}
                        </a>
                      </td>
                      <td className="px-4 py-3 text-muted">{item.requestedBy}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-muted">
                        {formatRelativeTime(item.playedAt)}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap text-muted tabular-nums">
                        {formatDuration(item.durationSec)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-2 border-t border-border px-4 py-3 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
              <span>
                Showing {start}–{end} of {total}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => goToPage(page - 1)}
                  disabled={page <= 1 || historyQuery.isFetching}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 font-medium text-text transition-colors hover:bg-white/5 disabled:opacity-40"
                >
                  <ChevronLeftIcon className="h-3.5 w-3.5" />
                  Previous
                </button>
                <span className="px-1 tabular-nums">
                  Page {page} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => goToPage(page + 1)}
                  disabled={page >= totalPages || historyQuery.isFetching}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 font-medium text-text transition-colors hover:bg-white/5 disabled:opacity-40"
                >
                  Next
                  <ChevronRightIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
