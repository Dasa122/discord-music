import type { GuildSummary } from "@music/shared";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../components/badge";
import { ConfirmDialog } from "../components/confirm-dialog";
import { EmptyState } from "../components/empty-state";
import { ErrorBanner } from "../components/error-banner";
import { GuildGuard } from "../components/guild-guard";
import { ListIcon, PencilIcon, PlayIcon, PlusIcon, TrashIcon, XIcon } from "../components/icons";
import { Skeleton } from "../components/skeleton";
import { useToast } from "../components/toast";
import { playPlaylistAction } from "../lib/actions";
import { getErrorMessage, type PlaylistSummary } from "../lib/api";
import { cn } from "../lib/cn";
import { formatRelativeTime } from "../lib/format";
import { withGuild } from "../lib/guild-selection";
import {
  useCreatePlaylist,
  useDeletePlaylist,
  useGuildAction,
  usePlaylists,
  useUpdatePlaylist,
} from "../lib/queries";
import { useGuildSelection } from "../lib/use-guild-selection";

export function PlaylistsPage() {
  const { guildId } = useGuildSelection();

  return <GuildGuard guildId={guildId}>{(guild) => <PlaylistsContent guild={guild} />}</GuildGuard>;
}

type DialogMode = "create" | "rename" | null;

type PlaylistDialogProps = {
  mode: DialogMode;
  initialName: string;
  initialShared: boolean;
  pending: boolean;
  error: unknown;
  onSubmit: (values: { name: string; isShared: boolean }) => void;
  onCancel: () => void;
};

function PlaylistDialog({
  mode,
  initialName,
  initialShared,
  pending,
  error,
  onSubmit,
  onCancel,
}: PlaylistDialogProps) {
  const open = mode !== null;
  const nameId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);
  const [isShared, setIsShared] = useState(initialShared);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setName(initialName);
    setIsShared(initialShared);
    setValidationError(null);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, initialName, initialShared]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) {
        onCancel();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, pending, onCancel]);

  if (!open) {
    return null;
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setValidationError("Give the playlist a name first.");
      return;
    }
    onSubmit({ name: trimmed, isShared });
  };

  const errorMessage = validationError ?? (error ? getErrorMessage(error) : null);

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
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${nameId}-title`}
        className="relative w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-xl shadow-black/30"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={`${nameId}-title`} className="text-base font-semibold text-text">
            {mode === "create" ? "New playlist" : "Rename playlist"}
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

        <form onSubmit={handleSubmit} className="mt-4">
          <label htmlFor={nameId} className="text-sm font-medium text-text">
            Playlist name
          </label>
          <input
            ref={inputRef}
            id={nameId}
            value={name}
            maxLength={100}
            onChange={(event) => {
              setName(event.target.value);
              if (validationError) {
                setValidationError(null);
              }
            }}
            placeholder="Friday night set"
            autoComplete="off"
            aria-invalid={errorMessage !== null}
            className="mt-1.5 w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-text placeholder:text-muted/60 focus:border-accent/60 focus:outline-none"
          />

          <label className="mt-4 flex items-start gap-2.5 rounded-lg border border-border bg-surface-raised px-3 py-2.5">
            <input
              type="checkbox"
              checked={isShared}
              onChange={(event) => setIsShared(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-accent"
            />
            <span>
              <span className="block text-sm font-medium text-text">Shared with the server</span>
              <span className="block text-xs leading-relaxed text-muted">
                Anyone in this server can load a shared playlist. Private playlists stay with you.
              </span>
            </span>
          </label>

          {errorMessage ? (
            <p role="alert" className="mt-3 text-xs leading-relaxed text-danger">
              {errorMessage}
            </p>
          ) : null}

          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onCancel}
              disabled={pending}
              className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-text transition-colors hover:bg-white/5 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-background transition-colors hover:bg-accent-strong disabled:opacity-50"
            >
              {pending ? "Saving…" : mode === "create" ? "Create playlist" : "Save name"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function PlaylistsContent({ guild }: { guild: GuildSummary }) {
  const playlistsQuery = usePlaylists(guild.id);
  const createMutation = useCreatePlaylist(guild.id);
  const updateMutation = useUpdatePlaylist(guild.id);
  const deleteMutation = useDeletePlaylist(guild.id);
  const playerAction = useGuildAction(guild.id);
  const { toast } = useToast();

  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [editing, setEditing] = useState<PlaylistSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PlaylistSummary | null>(null);

  const closeDialog = () => {
    setDialogMode(null);
    setEditing(null);
    createMutation.reset();
    updateMutation.reset();
  };

  const playlists = playlistsQuery.data ?? [];

  const handleDialogSubmit = (values: { name: string; isShared: boolean }) => {
    if (dialogMode === "create") {
      createMutation.mutate(values, {
        onSuccess: (playlist) => {
          closeDialog();
          toast(`Created “${playlist.name}”.`, "success");
        },
      });
      return;
    }

    if (dialogMode === "rename" && editing) {
      updateMutation.mutate(
        { playlistId: editing.id, name: values.name, isShared: values.isShared },
        {
          onSuccess: (playlist) => {
            closeDialog();
            toast(`Saved “${playlist.name}”.`, "success");
          },
        },
      );
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Library</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-text">Playlists</h1>
          <p className="mt-1 text-sm text-muted">
            {guild.name} · {playlists.length} {playlists.length === 1 ? "playlist" : "playlists"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            createMutation.reset();
            updateMutation.reset();
            setDialogMode("create");
          }}
          className="inline-flex items-center gap-1.5 self-start rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-background transition-colors hover:bg-accent-strong"
        >
          <PlusIcon className="h-4 w-4" />
          New playlist
        </button>
      </header>

      {playlistsQuery.isError ? (
        <ErrorBanner
          error={playlistsQuery.error}
          title="Could not load playlists"
          onRetry={() => {
            void playlistsQuery.refetch();
          }}
        />
      ) : null}

      {deleteMutation.error ? (
        <ErrorBanner
          error={deleteMutation.error}
          title="Could not delete the playlist"
          onDismiss={() => deleteMutation.reset()}
        />
      ) : null}

      {playerAction.error ? (
        <ErrorBanner
          error={playerAction.error}
          title="Could not load the playlist into the queue"
          onDismiss={() => playerAction.reset()}
        />
      ) : null}

      {playlistsQuery.isLoading ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          <li>
            <Skeleton className="h-36 w-full rounded-xl" />
          </li>
          <li>
            <Skeleton className="h-36 w-full rounded-xl" />
          </li>
        </ul>
      ) : playlistsQuery.isError && !playlistsQuery.data ? null : playlists.length === 0 ? (
        <EmptyState
          icon={<ListIcon className="h-5 w-5" />}
          title="No playlists yet"
          description="Create a playlist to keep a set of tracks ready for the next session. You can load it into the queue with one click."
          action={
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                createMutation.reset();
                updateMutation.reset();
                setDialogMode("create");
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-background transition-colors hover:bg-accent-strong"
            >
              <PlusIcon className="h-4 w-4" />
              Create a playlist
            </button>
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {playlists.map((playlist) => {
            const togglePending =
              updateMutation.isPending && updateMutation.variables?.playlistId === playlist.id;
            return (
              <li
                key={playlist.id}
                className="flex flex-col rounded-xl border border-border bg-surface p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      to={withGuild(`/playlists/${playlist.id}`, guild.id)}
                      className="block truncate text-sm font-semibold text-text underline-offset-4 hover:text-accent-strong hover:underline"
                    >
                      {playlist.name}
                    </Link>
                    <p className="mt-1 text-xs text-muted">
                      {playlist.itemCount} {playlist.itemCount === 1 ? "track" : "tracks"} ·{" "}
                      {formatRelativeTime(playlist.createdAt)}
                    </p>
                  </div>
                  <Badge variant={playlist.isShared ? "accent" : "neutral"}>
                    {playlist.isShared ? "Shared" : "Private"}
                  </Badge>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      playerAction.mutate(playPlaylistAction(playlist.id), {
                        onSuccess: () =>
                          toast(`Loading “${playlist.name}” into the queue.`, "success"),
                        onError: (error) => toast(getErrorMessage(error), "error"),
                      })
                    }
                    disabled={playerAction.isPending || playlist.itemCount === 0}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-xs font-medium text-accent-strong transition-colors hover:bg-accent/15 disabled:opacity-40"
                  >
                    <PlayIcon className="h-3.5 w-3.5" />
                    Load to queue
                  </button>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={playlist.isShared}
                    aria-label={
                      playlist.isShared
                        ? `Make ${playlist.name} private`
                        : `Share ${playlist.name} with the server`
                    }
                    title={
                      playlist.isShared
                        ? "Shared — click to make private"
                        : "Private — click to share"
                    }
                    onClick={() =>
                      updateMutation.mutate(
                        { playlistId: playlist.id, isShared: !playlist.isShared },
                        {
                          onSuccess: () =>
                            toast(
                              playlist.isShared
                                ? `“${playlist.name}” is private now.`
                                : `“${playlist.name}” is shared with the server.`,
                              "success",
                            ),
                          onError: (error) => toast(getErrorMessage(error), "error"),
                        },
                      )
                    }
                    disabled={togglePending}
                    className="inline-flex h-8 w-10 items-center justify-center rounded-lg border border-border transition-colors hover:bg-white/5 disabled:opacity-40"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "relative h-4 w-7 rounded-full transition-colors",
                        playlist.isShared ? "bg-accent" : "bg-white/10",
                      )}
                    >
                      <span
                        className={cn(
                          "absolute top-0.5 h-3 w-3 rounded-full bg-text transition-transform",
                          playlist.isShared ? "translate-x-[14px]" : "translate-x-[2px]",
                        )}
                      />
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setEditing(playlist);
                      createMutation.reset();
                      updateMutation.reset();
                      setDialogMode("rename");
                    }}
                    aria-label={`Rename ${playlist.name}`}
                    title="Rename"
                    className="rounded-lg border border-border p-1.5 text-muted transition-colors hover:bg-white/5 hover:text-text"
                  >
                    <PencilIcon className="h-3.5 w-3.5" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setDeleteTarget(playlist)}
                    aria-label={`Delete ${playlist.name}`}
                    title="Delete"
                    className="rounded-lg border border-danger/30 p-1.5 text-danger transition-colors hover:bg-danger/10"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <PlaylistDialog
        mode={dialogMode}
        initialName={editing?.name ?? ""}
        initialShared={editing?.isShared ?? false}
        pending={createMutation.isPending || updateMutation.isPending}
        error={createMutation.error ?? updateMutation.error}
        onSubmit={handleDialogSubmit}
        onCancel={closeDialog}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget ? `Delete “${deleteTarget.name}”?` : "Delete playlist?"}
        description="The playlist and every track in it are removed. This cannot be undone."
        confirmLabel="Delete playlist"
        destructive
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (!deleteTarget) {
            return;
          }
          deleteMutation.mutate(deleteTarget.id, {
            onSuccess: () => {
              toast(`Deleted “${deleteTarget.name}”.`, "success");
              setDeleteTarget(null);
            },
          });
        }}
        onCancel={() => {
          setDeleteTarget(null);
          deleteMutation.reset();
        }}
      />
    </div>
  );
}
