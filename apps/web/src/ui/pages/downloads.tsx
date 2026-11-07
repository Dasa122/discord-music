import type { DownloadEntry, GuildSummary } from "@music/shared";
import { Badge } from "../components/badge";
import { EmptyState } from "../components/empty-state";
import { ErrorBanner } from "../components/error-banner";
import { GuildGuard } from "../components/guild-guard";
import { DownloadIcon } from "../components/icons";
import { Skeleton } from "../components/skeleton";
import { cn } from "../lib/cn";
import { clamp, formatBytes, formatDurationMs, formatNumber, formatPercent } from "../lib/format";
import { useDownloads } from "../lib/queries";
import { useGuildSelection } from "../lib/use-guild-selection";

const STATE_LABELS: Record<DownloadEntry["state"], string> = {
  queued: "Queued",
  downloading: "Downloading",
  ready: "Ready",
  failed: "Failed",
};

const STATE_VARIANTS = {
  queued: "neutral",
  downloading: "accent",
  ready: "success",
  failed: "danger",
} as const;

/** Elapsed download time: start → finish, or start → now while live. */
function elapsedMs(entry: DownloadEntry): number | null {
  if (!entry.startedAt) {
    return null;
  }
  const started = Date.parse(entry.startedAt);
  if (!Number.isFinite(started)) {
    return null;
  }
  const finished = entry.finishedAt ? Date.parse(entry.finishedAt) : Date.now();
  if (!Number.isFinite(finished)) {
    return null;
  }
  return Math.max(0, finished - started);
}

function downloadSize(entry: DownloadEntry): string {
  if (entry.state === "downloading") {
    const total = entry.totalBytes === null ? "—" : formatBytes(entry.totalBytes);
    return `${formatBytes(entry.bytes)} / ${total}`;
  }
  return entry.bytes > 0 ? formatBytes(entry.bytes) : "—";
}

function formatGain(gainDb: number | null): string {
  if (gainDb === null) {
    return "—";
  }
  const sign = gainDb >= 0 ? "+" : "";
  return `${sign}${gainDb.toFixed(1)} dB`;
}

type StatProps = { label: string; value: string };

function Stat({ label, value }: StatProps) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-muted uppercase">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-text tabular-nums">{value}</dd>
    </div>
  );
}

type CapacityBarProps = { totalBytes: number; maxBytes: number };

function CapacityBar({ totalBytes, maxBytes }: CapacityBarProps) {
  const percent = maxBytes > 0 ? (totalBytes / maxBytes) * 100 : 0;
  const ratio = clamp(percent / 100, 0, 1);
  const warning = percent > 80;

  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-text">Session capacity</span>
        <span className={cn("tabular-nums", warning ? "text-warning" : "text-muted")}>
          {formatPercent(percent)} of {formatBytes(maxBytes)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Session download cache usage"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamp(percent, 0, 100))}
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10"
      >
        <span
          className={cn(
            "block h-full rounded-full transition-[width] duration-500 ease-out",
            warning ? "bg-warning" : "bg-accent",
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

type DownloadRowProps = { entry: DownloadEntry };

function DownloadRow({ entry }: DownloadRowProps) {
  const elapsed = elapsedMs(entry);

  return (
    <tr className="transition-colors hover:bg-white/[0.02]">
      <td className="px-4 py-3">
        <span className="block truncate font-medium text-text" title={entry.title}>
          {entry.title}
        </span>
        {entry.error ? (
          <span className="mt-0.5 block truncate text-xs text-danger">{entry.error}</span>
        ) : null}
      </td>
      <td className="px-4 py-3">
        <Badge variant={STATE_VARIANTS[entry.state]}>{STATE_LABELS[entry.state]}</Badge>
        {entry.state === "downloading" ? (
          entry.percent !== null ? (
            <span
              role="progressbar"
              aria-label={`Download progress for ${entry.title}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(clamp(entry.percent, 0, 100))}
              className="mt-1.5 block h-1 w-24 overflow-hidden rounded-full bg-white/10 sm:w-32"
            >
              <span
                className="block h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
                style={{ width: `${clamp(entry.percent, 0, 100)}%` }}
              />
            </span>
          ) : (
            <span
              role="progressbar"
              aria-label={`Downloading ${entry.title}`}
              className="mt-1.5 block h-1 w-24 overflow-hidden rounded-full bg-white/10 sm:w-32"
            >
              <span className="block h-full w-1/2 animate-pulse rounded-full bg-gradient-to-r from-accent/10 via-accent to-accent/10" />
            </span>
          )
        ) : null}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-muted tabular-nums">{downloadSize(entry)}</td>
      <td className="px-4 py-3 whitespace-nowrap text-muted tabular-nums">
        {elapsed === null ? "—" : formatDurationMs(elapsed)}
      </td>
      <td className="px-4 py-3 text-right whitespace-nowrap text-muted tabular-nums">
        {formatGain(entry.gainDb)}
      </td>
    </tr>
  );
}

function DownloadsSkeleton() {
  return (
    <div role="status" aria-label="Loading session downloads" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-80" />
      </div>
      <Skeleton className="h-16 w-full rounded-xl" />
      <Skeleton className="h-10 w-full rounded-xl" />
      <div className="space-y-px rounded-xl border border-border p-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  );
}

export function DownloadsPage() {
  const { guildId } = useGuildSelection();

  return <GuildGuard guildId={guildId}>{(guild) => <DownloadsContent guild={guild} />}</GuildGuard>;
}

function DownloadsContent({ guild }: { guild: GuildSummary }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useDownloads(guild.id);

  if (isLoading && !data) {
    return <DownloadsSkeleton />;
  }

  const entries = data?.entries ?? [];
  const maxBytes = data?.maxBytes ?? 0;
  const totalBytes = data?.totalBytes ?? 0;
  const store = data?.store ?? "local";
  const hasSession = data?.sessionId !== null && data?.sessionId !== undefined;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-medium tracking-wide text-muted uppercase">{guild.name}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-text">Session downloads</h1>
        <p className="mt-1 text-sm text-muted">
          Cleared automatically when the voice session ends.
        </p>
      </header>

      {isError ? (
        <ErrorBanner
          error={error}
          title="Could not load session downloads"
          onRetry={() => {
            void refetch();
          }}
        />
      ) : null}

      <section
        aria-label="Session download summary"
        className="rounded-xl border border-border bg-surface px-4 py-3.5"
      >
        <dl className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <Stat label="Tracks" value={formatNumber(entries.length)} />
          <Stat label="Cached" value={formatBytes(totalBytes)} />
          <Stat label="Cap" value={formatBytes(Math.max(0, maxBytes))} />
          <div className="ml-auto flex items-center gap-2">
            <dt className="text-xs tracking-wide text-muted uppercase">Store</dt>
            <dd>
              <Badge variant="neutral">{store === "s3" ? "S3" : "local"}</Badge>
            </dd>
          </div>
        </dl>
      </section>

      {hasSession ? <CapacityBar totalBytes={totalBytes} maxBytes={maxBytes} /> : null}

      <section className="overflow-hidden rounded-xl border border-border bg-surface">
        {isError && !data ? (
          <EmptyState
            icon={<DownloadIcon className="h-5 w-5" />}
            title="Session downloads unavailable"
            description="The bot did not report its download cache. Use Try again above to reconnect to it."
            className="border-0"
          />
        ) : !hasSession ? (
          <EmptyState
            icon={<DownloadIcon className="h-5 w-5" />}
            title="No active voice session — join a voice channel and play something."
            description="The bot caches tracks for the current session only; nothing is kept once it leaves voice."
            className="border-0"
          />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<DownloadIcon className="h-5 w-5" />}
            title="Nothing downloaded yet in this session."
            description="Tracks appear here while they are cached, and disappear when the session ends."
            className="border-0"
          />
        ) : (
          <div className="overflow-x-auto">
            <table
              aria-busy={isFetching}
              className={cn(
                "w-full min-w-[680px] table-fixed border-collapse text-left text-sm",
                isFetching && "opacity-70",
              )}
            >
              <colgroup>
                <col className="w-[42%]" />
                <col className="w-[24%]" />
                <col className="w-[14%]" />
                <col className="w-[11%]" />
                <col className="w-[9%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-border text-xs tracking-wide text-muted uppercase">
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Track
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    State
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Size
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Duration
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">
                    Gain
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {entries.map((entry) => (
                  <DownloadRow key={entry.trackId} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
