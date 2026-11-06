import type { GuildSummary } from "@music/shared";
import type { ReactNode } from "react";
import { useGuilds } from "../lib/queries";
import { EmptyState } from "./empty-state";
import { ErrorBanner } from "./error-banner";
import { MusicIcon } from "./icons";
import { Skeleton } from "./skeleton";

type GuildGuardProps = {
  guildId: string | null;
  children: (guild: GuildSummary) => ReactNode;
};

function GuildGuardSkeleton() {
  return (
    <div role="status" aria-label="Loading server" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-52 w-full rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-40 w-full rounded-xl lg:col-span-2" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    </div>
  );
}

/**
 * Renders guild-scoped content only when the selected guild exists in the
 * bot's guild list, with explicit loading, empty, and "not in guild" states.
 */
export function GuildGuard({ guildId, children }: GuildGuardProps) {
  const { data, isLoading, isError, error, refetch } = useGuilds();

  if (isLoading) {
    return <GuildGuardSkeleton />;
  }

  if (isError) {
    return (
      <ErrorBanner
        error={error}
        title="Could not load servers"
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  const guilds = data ?? [];

  if (guilds.length === 0) {
    return (
      <EmptyState
        icon={<MusicIcon className="h-5 w-5" />}
        title="No servers yet"
        description="Invite the bot to a Discord server. Once it joins, the server appears here automatically."
      />
    );
  }

  if (!guildId) {
    return (
      <EmptyState
        title="Select a server"
        description="Choose a server from the switcher in the sidebar to control its player."
      />
    );
  }

  const guild = guilds.find((entry) => entry.id === guildId);

  if (!guild) {
    return (
      <EmptyState
        title="Bot is not in this guild"
        description="This server id is not in the bot's guild list. Pick another server from the sidebar."
      />
    );
  }

  return <>{children(guild)}</>;
}
