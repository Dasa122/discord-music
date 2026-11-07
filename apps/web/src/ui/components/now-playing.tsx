import type { PlayerState } from "@music/shared";
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
  disconnectAction,
  loopAction,
  nextLoopMode,
  pauseAction,
  resumeAction,
  seekAction,
  shuffleAction,
  skipAction,
  stopAction,
  volumeAction,
} from "../lib/actions";
import type { GuildActionBody } from "../lib/api";
import { cn } from "../lib/cn";
import { clamp, formatDuration, formatPercent } from "../lib/format";
import { useDownloads, useGuildAction } from "../lib/queries";
import { Badge } from "./badge";
import { ConfirmDialog } from "./confirm-dialog";
import { ErrorBanner } from "./error-banner";
import {
  MusicIcon,
  PauseIcon,
  PlayIcon,
  PowerIcon,
  RepeatIcon,
  ShuffleIcon,
  SkipIcon,
  StopIcon,
  VolumeIcon,
} from "./icons";

const SOURCE_LABELS = {
  youtube: "YouTube",
  direct: "Direct link",
  unknown: "Link",
} as const;

const LOOP_LABELS = {
  off: "Loop off",
  track: "Loop track",
  queue: "Loop queue",
} as const;

type ControlButtonProps = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
};

function ControlButton({ label, onClick, disabled, active, children }: ControlButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded-lg border transition-colors disabled:opacity-40",
        active
          ? "border-accent/40 bg-accent/15 text-accent-strong"
          : "border-border text-muted hover:bg-white/5 hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

type NowPlayingProps = {
  guildId: string;
  state: PlayerState;
};

export function NowPlaying({ guildId, state }: NowPlayingProps) {
  const action = useGuildAction(guildId);
  const downloadsQuery = useDownloads(guildId);
  const current = state.current;
  const duration = current?.durationSec ?? null;

  const cachingEntry = current
    ? (downloadsQuery.data?.entries.find(
        (entry) => entry.trackId === current.id && entry.state === "downloading",
      ) ?? null)
    : null;
  const cachingLabel = cachingEntry
    ? cachingEntry.percent === null
      ? "Caching…"
      : `Caching ${formatPercent(cachingEntry.percent)}`
    : null;

  const [nowMs, setNowMs] = useState(() => Date.now());
  const anchorRef = useRef({ position: state.positionSec, at: Date.now() });
  const [volume, setVolume] = useState(state.volume);
  const [seekTarget, setSeekTarget] = useState<number | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [failedThumbnail, setFailedThumbnail] = useState<string | null>(null);

  const pendingType = action.isPending ? action.variables?.type : undefined;

  useEffect(() => {
    const updatedAt = Date.parse(state.updatedAt);
    anchorRef.current = {
      position: state.positionSec,
      at: Number.isFinite(updatedAt) ? Math.min(updatedAt, Date.now()) : Date.now(),
    };
    setNowMs(Date.now());
  }, [state.positionSec, state.updatedAt]);

  useEffect(() => {
    if (!state.playing || state.paused) {
      return;
    }
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [state.playing, state.paused]);

  useEffect(() => {
    setVolume(state.volume);
  }, [state.volume]);

  const elapsed = state.playing && !state.paused ? (nowMs - anchorRef.current.at) / 1000 : 0;
  const position = clamp(
    anchorRef.current.position + elapsed,
    0,
    duration ?? Number.POSITIVE_INFINITY,
  );
  const progress = duration && duration > 0 ? clamp(position / duration, 0, 1) : 0;

  const status = !state.connected
    ? "disconnected"
    : state.paused
      ? "paused"
      : state.playing
        ? "live"
        : "idle";
  const statusLabel =
    status === "disconnected"
      ? "Disconnected"
      : status === "paused"
        ? "Paused"
        : status === "live"
          ? "Live"
          : "Idle";

  const announcement = current
    ? `${status === "paused" ? "Paused" : status === "live" ? "Now playing" : "Loaded"}: ${current.title}`
    : "Nothing is playing";

  const thumbnailUrl = current?.thumbnailUrl ?? null;
  const showThumbnail = thumbnailUrl !== null && failedThumbnail !== thumbnailUrl;

  const commitVolume = () => {
    if (volume !== state.volume && !action.isPending) {
      action.mutate(volumeAction(volume));
    }
  };

  const run = (body: GuildActionBody) => {
    if (!action.isPending) {
      action.mutate(body);
    }
  };

  const handleSeekClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (!duration || duration <= 0 || action.isPending) {
      return;
    }
    // Keyboard activation reports detail 0; arrow keys are handled separately.
    if (event.detail === 0) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    setSeekTarget(Math.round(ratio * duration));
  };

  return (
    <section
      aria-label="Now playing"
      className="rounded-xl border border-border bg-surface p-4 sm:p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="relative flex h-2 w-2">
            <span
              className={cn(
                "absolute inline-flex h-full w-full rounded-full",
                status === "live" ? "animate-ping bg-success/60" : "bg-transparent",
              )}
            />
            <span
              className={cn(
                "relative inline-flex h-2 w-2 rounded-full",
                status === "live"
                  ? "bg-success"
                  : status === "paused"
                    ? "bg-warning"
                    : "bg-muted/50",
              )}
            />
          </span>
          <h2 className="text-sm font-semibold tracking-tight text-text">Now playing</h2>
          {state.queue.length > 0 ? (
            <span className="text-xs text-muted">{state.queue.length} queued</span>
          ) : null}
        </div>
        <Badge
          variant={status === "live" ? "success" : status === "paused" ? "warning" : "neutral"}
        >
          {statusLabel}
        </Badge>
      </div>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row">
        <div className="w-full shrink-0 sm:w-44">
          <div className="relative aspect-video overflow-hidden rounded-lg border border-border bg-surface-raised">
            {showThumbnail ? (
              <img
                src={thumbnailUrl}
                alt=""
                loading="lazy"
                onError={() => setFailedThumbnail(thumbnailUrl)}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-muted">
                <MusicIcon className="h-7 w-7" />
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          {current ? (
            <>
              <a
                href={current.url}
                target="_blank"
                rel="noreferrer noopener"
                className="line-clamp-2 text-base font-semibold leading-snug text-text underline-offset-4 hover:text-accent-strong hover:underline"
              >
                {current.title}
              </a>
              {cachingLabel ? (
                <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent-strong">
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
                  />
                  {cachingLabel}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <Badge variant={current.source === "youtube" ? "accent" : "neutral"}>
                  {SOURCE_LABELS[current.source]}
                </Badge>
                <span>Requested by {current.requestedBy.name}</span>
              </div>

              <div className="mt-4">
                <div className="flex items-center justify-between text-xs text-muted tabular-nums">
                  <span>{formatDuration(position)}</span>
                  <span>{formatDuration(duration)}</span>
                </div>
                <button
                  type="button"
                  onClick={handleSeekClick}
                  onKeyDown={(event) => {
                    if (!duration || duration <= 0 || action.isPending) {
                      return;
                    }
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                      return;
                    }
                    event.preventDefault();
                    const delta = event.key === "ArrowRight" ? 10 : -10;
                    setSeekTarget(Math.round(clamp(position + delta, 0, duration)));
                  }}
                  disabled={!duration || duration <= 0 || action.isPending}
                  aria-label={
                    duration
                      ? `Seek bar, ${formatDuration(position)} of ${formatDuration(duration)}. Click or use arrow keys to seek.`
                      : "Seek unavailable because the track duration is unknown"
                  }
                  title={duration ? "Click to seek" : "Duration unknown"}
                  className="group mt-1.5 block w-full rounded-full py-1.5 disabled:cursor-default"
                >
                  <span className="block h-1.5 w-full overflow-hidden rounded-full bg-white/10 transition-colors group-hover:bg-white/15">
                    <span
                      className="block h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
                      style={{ width: `${progress * 100}%` }}
                    />
                  </span>
                </button>
              </div>
            </>
          ) : (
            <div className="flex h-full min-h-24 flex-col justify-center">
              <p className="text-base font-semibold text-text">Nothing playing</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                {state.connected
                  ? "The queue is empty. Add a track below to start playback."
                  : "The bot is not connected to voice. Join a voice channel and run /play once in Discord, then control it from here."}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => run(state.playing && !state.paused ? pauseAction() : resumeAction())}
          disabled={!current || action.isPending}
          aria-label={state.playing && !state.paused ? "Pause" : "Resume"}
          title={state.playing && !state.paused ? "Pause" : "Resume"}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-background transition-colors hover:bg-accent-strong disabled:opacity-40"
        >
          {state.playing && !state.paused ? (
            <PauseIcon className="h-5 w-5" />
          ) : (
            <PlayIcon className="h-5 w-5" />
          )}
        </button>

        <ControlButton
          label="Skip track"
          onClick={() => run(skipAction())}
          disabled={action.isPending || (!current && state.queue.length === 0)}
        >
          <SkipIcon className="h-4 w-4" />
        </ControlButton>

        <ControlButton
          label="Stop playback"
          onClick={() => setConfirmStop(true)}
          disabled={action.isPending || (!current && !state.connected)}
        >
          <StopIcon className="h-4 w-4" />
        </ControlButton>

        <ControlButton
          label="Shuffle queue"
          onClick={() => run(shuffleAction())}
          disabled={action.isPending || state.queue.length < 2}
        >
          <ShuffleIcon className="h-4 w-4" />
        </ControlButton>

        <ControlButton
          label={LOOP_LABELS[state.loop]}
          onClick={() => run(loopAction(nextLoopMode(state.loop)))}
          disabled={action.isPending}
          active={state.loop !== "off"}
        >
          <RepeatIcon className="h-4 w-4" />
        </ControlButton>

        <div className="ml-auto flex items-center gap-2">
          <VolumeIcon className="h-4 w-4 text-muted" />
          <input
            type="range"
            min={0}
            max={200}
            step={1}
            value={volume}
            onChange={(event) => setVolume(Number(event.target.value))}
            onPointerUp={commitVolume}
            onKeyUp={(event) => {
              if (
                [
                  "ArrowLeft",
                  "ArrowRight",
                  "ArrowUp",
                  "ArrowDown",
                  "Home",
                  "End",
                  "PageUp",
                  "PageDown",
                ].includes(event.key)
              ) {
                commitVolume();
              }
            }}
            onBlur={commitVolume}
            disabled={action.isPending}
            aria-label="Volume, 0 to 200 percent"
            className="h-1.5 w-24 cursor-pointer accent-accent disabled:opacity-40 sm:w-32"
          />
          <span className="w-9 text-right text-xs text-muted tabular-nums">{volume}%</span>
          <ControlButton
            label="Disconnect from voice"
            onClick={() => setConfirmDisconnect(true)}
            disabled={action.isPending || !state.connected}
          >
            <PowerIcon className="h-4 w-4" />
          </ControlButton>
        </div>
      </div>

      {action.error ? (
        <ErrorBanner
          error={action.error}
          title="Action failed"
          onDismiss={() => action.reset()}
          className="mt-4"
        />
      ) : null}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <ConfirmDialog
        open={seekTarget !== null}
        title="Seek in the current track?"
        description={
          seekTarget !== null
            ? `Jump to ${formatDuration(seekTarget)} in “${current?.title ?? "the current track"}”.`
            : undefined
        }
        confirmLabel="Seek"
        pending={pendingType === "seek"}
        onConfirm={() => {
          if (seekTarget !== null) {
            action.mutate(seekAction(seekTarget), {
              onSettled: () => setSeekTarget(null),
            });
          }
        }}
        onCancel={() => setSeekTarget(null)}
      />

      <ConfirmDialog
        open={confirmStop}
        title="Stop playback?"
        description="Playback stops and the queue is cleared. This cannot be undone."
        confirmLabel="Stop"
        destructive
        pending={pendingType === "stop"}
        onConfirm={() => action.mutate(stopAction(), { onSettled: () => setConfirmStop(false) })}
        onCancel={() => setConfirmStop(false)}
      />

      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect from voice?"
        description="The bot leaves the voice channel and the queue is lost."
        confirmLabel="Disconnect"
        destructive
        pending={pendingType === "disconnect"}
        onConfirm={() =>
          action.mutate(disconnectAction(), { onSettled: () => setConfirmDisconnect(false) })
        }
        onCancel={() => setConfirmDisconnect(false)}
      />
    </section>
  );
}
