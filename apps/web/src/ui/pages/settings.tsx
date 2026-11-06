import type { GuildSettings, GuildSummary } from "@music/shared";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import { Badge } from "../components/badge";
import { ErrorBanner } from "../components/error-banner";
import { GuildGuard } from "../components/guild-guard";
import { SettingsIcon } from "../components/icons";
import { Skeleton } from "../components/skeleton";
import { Spinner } from "../components/spinner";
import { useToast } from "../components/toast";
import { getErrorMessage } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { usePlayerState, useSettings, useUpdateSettings } from "../lib/queries";
import { useGuildSelection } from "../lib/use-guild-selection";

type SettingsForm = {
  djRoleId: string;
  defaultVolume: string;
  maxQueueLength: string;
  allowedChannelIds: string;
};

const LOOP_LABELS = {
  off: "Off",
  track: "Track",
  queue: "Queue",
} as const;

function toForm(settings: GuildSettings): SettingsForm {
  return {
    djRoleId: settings.djRoleId ?? "",
    defaultVolume: String(settings.defaultVolume),
    maxQueueLength: String(settings.maxQueueLength),
    allowedChannelIds: settings.allowedChannelIds.join(", "),
  };
}

function parseBoundedInteger(value: string, min: number, max: number): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}

function parseChannelIds(value: string): string[] {
  const ids = value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set(ids)];
}

export function SettingsPage() {
  const { guildId } = useGuildSelection();

  return <GuildGuard guildId={guildId}>{(guild) => <SettingsContent guild={guild} />}</GuildGuard>;
}

function StatusRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right text-text">{children}</dd>
    </div>
  );
}

function SettingsContent({ guild }: { guild: GuildSummary }) {
  const settingsQuery = useSettings(guild.id);
  const stateQuery = usePlayerState(guild.id);
  const updateMutation = useUpdateSettings(guild.id);
  const { toast } = useToast();

  const [form, setForm] = useState<SettingsForm | null>(null);
  const djRoleId = useId();
  const defaultVolumeId = useId();
  const maxQueueLengthId = useId();
  const allowedChannelsId = useId();

  useEffect(() => {
    if (settingsQuery.data) {
      setForm(toForm(settingsQuery.data));
    }
  }, [settingsQuery.data]);

  const settings = settingsQuery.data;
  const playerState = stateQuery.data;

  const volumeValue = form ? parseBoundedInteger(form.defaultVolume, 0, 200) : null;
  const maxQueueValue = form ? parseBoundedInteger(form.maxQueueLength, 1, 1000) : null;
  const channelIds = form ? parseChannelIds(form.allowedChannelIds) : [];

  const dirty =
    form !== null &&
    settings !== undefined &&
    (form.djRoleId.trim() !== (settings.djRoleId ?? "") ||
      form.defaultVolume.trim() !== String(settings.defaultVolume) ||
      form.maxQueueLength.trim() !== String(settings.maxQueueLength) ||
      channelIds.join(",") !== settings.allowedChannelIds.join(","));

  useEffect(() => {
    if (!dirty) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form || volumeValue === null || maxQueueValue === null) {
      return;
    }
    updateMutation.mutate(
      {
        djRoleId: form.djRoleId.trim() === "" ? null : form.djRoleId.trim(),
        defaultVolume: volumeValue,
        maxQueueLength: maxQueueValue,
        allowedChannelIds: channelIds,
      },
      {
        onSuccess: () => toast("Settings saved.", "success"),
      },
    );
  };

  if (settingsQuery.isLoading && !settings) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-80 w-full rounded-xl lg:col-span-2" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (settingsQuery.isError && !settings) {
    return (
      <ErrorBanner
        error={settingsQuery.error}
        title="Could not load settings"
        onRetry={() => {
          void settingsQuery.refetch();
        }}
      />
    );
  }

  if (!settings || !form) {
    return <Skeleton className="h-80 w-full rounded-xl" />;
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-medium tracking-wide text-muted uppercase">Server</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-text">Settings</h1>
        <p className="mt-1 text-sm text-muted">{guild.name}</p>
      </header>

      {updateMutation.error ? (
        <ErrorBanner
          error={updateMutation.error}
          title="Could not save settings"
          onDismiss={() => updateMutation.reset()}
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-border bg-surface p-4 sm:p-5 lg:col-span-2"
        >
          <div className="flex items-center gap-2">
            <SettingsIcon className="h-4 w-4 text-muted" />
            <h2 className="text-sm font-semibold tracking-tight text-text">Player defaults</h2>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            These values are stored in Postgres and survive bot restarts.
          </p>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor={djRoleId} className="text-sm font-medium text-text">
                DJ role ID <span className="font-normal text-muted">(optional)</span>
              </label>
              <input
                id={djRoleId}
                value={form.djRoleId}
                onChange={(event) => setForm({ ...form, djRoleId: event.target.value })}
                placeholder="123456789012345678"
                autoComplete="off"
                spellCheck={false}
                className="mt-1.5 w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-text placeholder:text-muted/60 focus:border-accent/60 focus:outline-none"
              />
              <p className="mt-1.5 text-xs leading-relaxed text-muted">
                Members with this Discord role can skip, stop, seek, shuffle, and change volume.
                Leave empty to allow everyone.
              </p>
            </div>

            <div>
              <label htmlFor={defaultVolumeId} className="text-sm font-medium text-text">
                Default volume
              </label>
              <div className="relative mt-1.5">
                <input
                  id={defaultVolumeId}
                  type="number"
                  min={0}
                  max={200}
                  step={1}
                  inputMode="numeric"
                  value={form.defaultVolume}
                  onChange={(event) => setForm({ ...form, defaultVolume: event.target.value })}
                  aria-invalid={volumeValue === null}
                  className="w-full rounded-lg border border-border bg-surface-raised py-2 pr-9 pl-3 text-sm text-text tabular-nums focus:border-accent/60 focus:outline-none"
                />
                <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted">
                  %
                </span>
              </div>
              {volumeValue === null ? (
                <p role="alert" className="mt-1.5 text-xs text-danger">
                  Enter a whole number from 0 to 200.
                </p>
              ) : (
                <p className="mt-1.5 text-xs leading-relaxed text-muted">
                  Applied when the bot joins a voice channel.
                </p>
              )}
            </div>

            <div>
              <label htmlFor={maxQueueLengthId} className="text-sm font-medium text-text">
                Max queue length
              </label>
              <input
                id={maxQueueLengthId}
                type="number"
                min={1}
                max={1000}
                step={1}
                inputMode="numeric"
                value={form.maxQueueLength}
                onChange={(event) => setForm({ ...form, maxQueueLength: event.target.value })}
                aria-invalid={maxQueueValue === null}
                className="mt-1.5 w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-text tabular-nums focus:border-accent/60 focus:outline-none"
              />
              {maxQueueValue === null ? (
                <p role="alert" className="mt-1.5 text-xs text-danger">
                  Enter a whole number from 1 to 1000.
                </p>
              ) : (
                <p className="mt-1.5 text-xs leading-relaxed text-muted">
                  Requests beyond this limit are rejected with a message.
                </p>
              )}
            </div>

            <div className="sm:col-span-2">
              <label htmlFor={allowedChannelsId} className="text-sm font-medium text-text">
                Allowed channel IDs
              </label>
              <input
                id={allowedChannelsId}
                value={form.allowedChannelIds}
                onChange={(event) => setForm({ ...form, allowedChannelIds: event.target.value })}
                placeholder="123456789012345678, 987654321098765432"
                autoComplete="off"
                spellCheck={false}
                className="mt-1.5 w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-text placeholder:text-muted/60 focus:border-accent/60 focus:outline-none"
              />
              <p className="mt-1.5 text-xs leading-relaxed text-muted">
                Comma-separated text channel IDs where commands are allowed.{" "}
                {channelIds.length === 0
                  ? "Empty means any channel."
                  : `${channelIds.length} ${channelIds.length === 1 ? "channel" : "channels"} allowlisted.`}
              </p>
            </div>
          </div>

          <div className="mt-6 flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              {dirty ? (
                <Badge variant="warning">Unsaved changes</Badge>
              ) : (
                <span className="text-xs text-muted">All changes saved.</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setForm(toForm(settings));
                  updateMutation.reset();
                }}
                disabled={!dirty || updateMutation.isPending}
                className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-text transition-colors hover:bg-white/5 disabled:opacity-40"
              >
                Discard
              </button>
              <button
                type="submit"
                disabled={
                  !dirty ||
                  volumeValue === null ||
                  maxQueueValue === null ||
                  updateMutation.isPending
                }
                className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-background transition-colors hover:bg-accent-strong disabled:opacity-50"
              >
                {updateMutation.isPending ? "Saving…" : "Save settings"}
              </button>
            </div>
          </div>
        </form>

        <aside className="rounded-xl border border-border bg-surface p-4 sm:p-5">
          <h2 className="text-sm font-semibold tracking-tight text-text">Bot and voice</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Read-only status reported by the bot. Updates every 2 seconds.
          </p>

          {stateQuery.isLoading && !playerState ? (
            <Spinner className="mt-4" label="Checking bot status" />
          ) : stateQuery.isError ? (
            <p className="mt-4 text-sm leading-relaxed text-muted">
              {getErrorMessage(stateQuery.error)}
            </p>
          ) : playerState ? (
            <dl className="mt-4 divide-y divide-border text-sm">
              <StatusRow label="Connection">
                <Badge variant={playerState.connected ? "success" : "neutral"}>
                  {playerState.connected ? "Connected" : "Disconnected"}
                </Badge>
              </StatusRow>
              <StatusRow label="Voice channel">
                <span className="font-mono text-xs">{playerState.voiceChannelId ?? "—"}</span>
              </StatusRow>
              <StatusRow label="Playback">
                {playerState.playing ? (playerState.paused ? "Paused" : "Playing") : "Idle"}
              </StatusRow>
              <StatusRow label="Volume">{playerState.volume}%</StatusRow>
              <StatusRow label="Loop">{LOOP_LABELS[playerState.loop]}</StatusRow>
              <StatusRow label="Queue">{playerState.queue.length} tracks</StatusRow>
              <StatusRow label="Updated">{formatRelativeTime(playerState.updatedAt)}</StatusRow>
            </dl>
          ) : (
            <p className="mt-4 text-sm text-muted">No state yet.</p>
          )}

          <p className="mt-4 text-xs leading-relaxed text-muted">
            The dashboard is remote control only. Audio always plays in the Discord voice channel.
          </p>
        </aside>
      </div>
    </div>
  );
}
