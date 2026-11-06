import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge } from "../components/badge";
import { ConfirmDialog } from "../components/confirm-dialog";
import { EmptyState } from "../components/empty-state";
import { ErrorBanner } from "../components/error-banner";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronUpIcon,
  ListIcon,
  MusicIcon,
  PlayIcon,
  TrashIcon,
} from "../components/icons";
import { Skeleton } from "../components/skeleton";
import { useToast } from "../components/toast";
import { playPlaylistAction } from "../lib/actions";
import { ApiError, getErrorMessage, type PlaylistItemView } from "../lib/api";
import { formatDuration, formatRelativeTime } from "../lib/format";
import { withGuild } from "../lib/guild-selection";
import {
  useGuildAction,
  useMe,
  usePlaylist,
  useRemovePlaylistItem,
  useReorderPlaylist,
} from "../lib/queries";
import { useGuildSelection } from "../lib/use-guild-selection";

export function PlaylistDetailPage() {
  const params = useParams<{ id: string }>();
  const playlistId = params.id ?? null;
  const { guildId: selectedGuildId } = useGuildSelection();
  const playlistQuery = usePlaylist(playlistId);
  const playlist = playlistQuery.data;
  const guildId = playlist?.guildId ?? selectedGuildId;

  const removeMutation = useRemovePlaylistItem(playlistId ?? "", guildId);
  const reorderMutation = useReorderPlaylist(playlistId ?? "");
  const playerAction = useGuildAction(guildId);
  const meQuery = useMe();
  const me = meQuery.data;
  const { toast } = useToast();
  const [removeTarget, setRemoveTarget] = useState<PlaylistItemView | null>(null);

  const clearErrors = () => {
    removeMutation.reset();
    reorderMutation.reset();
    playerAction.reset();
  };
  const actionError = removeMutation.error ?? reorderMutation.error ?? playerAction.error;

  if (!playlistId) {
    return (
      <EmptyState
        title="Playlist not found"
        description="The playlist link is missing an id."
        action={
          <Link
            to={withGuild("/playlists", selectedGuildId)}
            className="text-sm font-medium text-accent underline-offset-4 hover:underline"
          >
            Back to playlists
          </Link>
        }
      />
    );
  }

  if (playlistQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (playlistQuery.isError) {
    const notFound = playlistQuery.error instanceof ApiError && playlistQuery.error.status === 404;
    return notFound ? (
      <EmptyState
        icon={<ListIcon className="h-5 w-5" />}
        title="Playlist not found"
        description="It may have been deleted, or it belongs to a different server."
        action={
          <Link
            to={withGuild("/playlists", selectedGuildId)}
            className="text-sm font-medium text-accent underline-offset-4 hover:underline"
          >
            Back to playlists
          </Link>
        }
      />
    ) : (
      <ErrorBanner
        error={playlistQuery.error}
        title="Could not load the playlist"
        onRetry={() => {
          void playlistQuery.refetch();
        }}
      />
    );
  }

  if (!playlist) {
    return null;
  }

  const items = playlist.items ?? [];

  const moveItem = (from: number, to: number) => {
    if (reorderMutation.isPending || to < 0 || to >= items.length) {
      return;
    }
    const ids = items.map((item) => item.id);
    const [moved] = ids.splice(from, 1);
    if (!moved) {
      return;
    }
    ids.splice(to, 0, moved);
    reorderMutation.mutate(ids, {
      onError: (error) => toast(getErrorMessage(error), "error"),
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={withGuild("/playlists", guildId)}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-text"
        >
          <ChevronLeftIcon className="h-3.5 w-3.5" />
          Playlists
        </Link>

        <header className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-semibold tracking-tight text-text">
                {playlist.name}
              </h1>
              <Badge variant={playlist.isShared ? "accent" : "neutral"}>
                {playlist.isShared ? "Shared" : "Private"}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted">
              {items.length} {items.length === 1 ? "track" : "tracks"} · created{" "}
              {formatRelativeTime(playlist.createdAt)}
            </p>
          </div>

          <button
            type="button"
            onClick={() =>
              playerAction.mutate(playPlaylistAction(playlist.id), {
                onSuccess: () => toast(`Loading “${playlist.name}” into the queue.`, "success"),
                onError: (error) => toast(getErrorMessage(error), "error"),
              })
            }
            disabled={playerAction.isPending || items.length === 0}
            className="inline-flex items-center gap-1.5 self-start rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm font-medium text-accent-strong transition-colors hover:bg-accent/15 disabled:opacity-40"
          >
            <PlayIcon className="h-4 w-4" />
            Load to queue
          </button>
        </header>
      </div>

      {actionError ? (
        <ErrorBanner error={actionError} title="Playlist action failed" onDismiss={clearErrors} />
      ) : null}

      <section className="overflow-hidden rounded-xl border border-border bg-surface">
        <header className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight text-text">Tracks</h2>
        </header>

        {items.length === 0 ? (
          <EmptyState
            icon={<MusicIcon className="h-5 w-5" />}
            title="This playlist is empty"
            description="Playlists are filled from Discord with /playlist save, or one track at a time. Nothing has been added yet."
            className="border-0"
          />
        ) : (
          <ol className="divide-y divide-border">
            {items.map((item, index) => (
              <li key={item.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
                <span className="w-5 shrink-0 text-right text-xs text-muted tabular-nums">
                  {index + 1}
                </span>

                <span className="hidden h-9 w-14 shrink-0 overflow-hidden rounded-md border border-border bg-surface-raised sm:flex sm:items-center sm:justify-center">
                  {item.thumbnailUrl ? (
                    <img
                      src={item.thumbnailUrl}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <MusicIcon className="h-4 w-4 text-muted" />
                  )}
                </span>

                <div className="min-w-0 flex-1">
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="block truncate text-sm font-medium text-text underline-offset-4 hover:text-accent-strong hover:underline"
                  >
                    {item.title}
                  </a>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    Added by {item.addedBy === me?.sub ? "you" : item.addedBy}
                    <span className="sm:hidden"> · {formatDuration(item.durationSec)}</span>
                  </p>
                </div>

                <span className="hidden shrink-0 text-xs text-muted tabular-nums sm:block">
                  {formatDuration(item.durationSec)}
                </span>

                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveItem(index, index - 1)}
                    disabled={reorderMutation.isPending || index === 0}
                    aria-label={`Move ${item.title} up`}
                    title="Move up"
                    className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted transition-colors hover:bg-white/5 hover:text-text disabled:opacity-30"
                  >
                    <ChevronUpIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveItem(index, index + 1)}
                    disabled={reorderMutation.isPending || index === items.length - 1}
                    aria-label={`Move ${item.title} down`}
                    title="Move down"
                    className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted transition-colors hover:bg-white/5 hover:text-text disabled:opacity-30"
                  >
                    <ChevronDownIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setRemoveTarget(item)}
                    aria-label={`Remove ${item.title}`}
                    title="Remove"
                    className="flex h-7 w-7 items-center justify-center rounded-md border border-danger/30 text-danger transition-colors hover:bg-danger/10"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <aside className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold text-text">Save what is playing now</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          Playlists are snapshotted from Discord. Run{" "}
          <code className="rounded bg-white/5 px-1 py-0.5 text-xs">
            /playlist save {playlist.name}
          </code>{" "}
          in the server to copy the current queue into a playlist. This page edits individual
          tracks.
        </p>
      </aside>

      <ConfirmDialog
        open={removeTarget !== null}
        title={removeTarget ? `Remove “${removeTarget.title}”?` : "Remove track?"}
        description="The track is removed from this playlist. It stays in the queue if it is already queued."
        confirmLabel="Remove track"
        destructive
        pending={removeMutation.isPending}
        onConfirm={() => {
          if (!removeTarget) {
            return;
          }
          removeMutation.mutate(removeTarget.id, {
            onSuccess: () => {
              toast(`Removed “${removeTarget.title}”.`, "success");
              setRemoveTarget(null);
            },
            onError: (error) => toast(getErrorMessage(error), "error"),
          });
        }}
        onCancel={() => {
          setRemoveTarget(null);
          removeMutation.reset();
        }}
      />
    </div>
  );
}
