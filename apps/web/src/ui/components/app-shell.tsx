import type { GuildSummary } from "@music/shared";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { getErrorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import { formatNumber } from "../lib/format";
import { withGuild } from "../lib/guild-selection";
import { useLogout, useMe } from "../lib/queries";
import { useGuildSelection } from "../lib/use-guild-selection";
import {
  ChevronDownIcon,
  DownloadIcon,
  GridIcon,
  HistoryIcon,
  ListIcon,
  LogOutIcon,
  LogoIcon,
  MenuIcon,
  PlaylistIcon,
  SettingsIcon,
  XIcon,
} from "./icons";
import { Skeleton } from "./skeleton";
import { useToast } from "./toast";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: GridIcon, end: true },
  { to: "/queue", label: "Queue", icon: ListIcon, end: false },
  { to: "/downloads", label: "Downloads", icon: DownloadIcon, end: false },
  { to: "/playlists", label: "Playlists", icon: PlaylistIcon, end: false },
  { to: "/history", label: "History", icon: HistoryIcon, end: false },
  { to: "/settings", label: "Settings", icon: SettingsIcon, end: false },
] as const;

function GuildAvatar({ guild, size = "md" }: { guild: GuildSummary | null; size?: "sm" | "md" }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const iconUrl = guild?.iconUrl ?? null;
  const showImage = iconUrl !== null && failedUrl !== iconUrl;
  const initial = guild?.name.trim().charAt(0).toUpperCase() || "?";
  const sizeClass = size === "sm" ? "h-8 w-8 rounded-lg text-xs" : "h-10 w-10 rounded-xl text-sm";

  if (showImage) {
    return (
      <img
        src={iconUrl}
        alt=""
        loading="lazy"
        onError={() => setFailedUrl(iconUrl)}
        className={cn("shrink-0 border border-border object-cover", sizeClass)}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center border border-border bg-accent/15 font-semibold text-accent-strong",
        sizeClass,
      )}
    >
      {initial}
    </span>
  );
}

type GuildSwitcherProps = {
  guilds: GuildSummary[];
  guildId: string | null;
  onSelect: (guildId: string) => void;
};

function GuildSwitcher({ guilds, guildId, onSelect }: GuildSwitcherProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selected = guilds.find((guild) => guild.id === guildId) ?? null;

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (guilds.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border px-3 py-2.5">
        <p className="text-xs font-medium text-text">No servers available</p>
        <p className="mt-0.5 text-xs text-muted">Invite the bot to a Discord server.</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="Switch server"
        className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface-raised px-2.5 py-2 text-left transition-colors hover:border-accent/40"
      >
        <GuildAvatar guild={selected} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text">
            {selected?.name ?? "Select a server"}
          </span>
          <span className="block text-xs text-muted">
            {selected ? `${formatNumber(selected.memberCount)} members` : "No server selected"}
          </span>
        </span>
        <ChevronDownIcon
          className={cn("h-4 w-4 shrink-0 text-muted transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <ul
          aria-label="Servers"
          className="absolute inset-x-0 z-30 mt-2 max-h-72 space-y-0.5 overflow-y-auto rounded-xl border border-border bg-surface-raised p-1 shadow-xl shadow-black/40"
        >
          {guilds.map((guild) => {
            const isSelected = guild.id === guildId;
            return (
              <li key={guild.id}>
                <button
                  type="button"
                  aria-current={isSelected ? "true" : undefined}
                  onClick={() => {
                    onSelect(guild.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors",
                    isSelected ? "bg-accent/15" : "hover:bg-white/5",
                  )}
                >
                  <GuildAvatar guild={guild} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-text">{guild.name}</span>
                    <span className="block text-xs text-muted">
                      {formatNumber(guild.memberCount)} members
                      {guild.playing && guild.currentTitle ? ` · ${guild.currentTitle}` : ""}
                    </span>
                  </span>
                  {guild.connected ? (
                    <span
                      role="img"
                      aria-label="Bot connected"
                      className="h-2 w-2 shrink-0 rounded-full bg-success"
                    />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

type SidebarContentProps = {
  guilds: GuildSummary[];
  guildId: string | null;
  guildsLoading: boolean;
  onSelectGuild: (guildId: string) => void;
  onClose?: () => void;
  closeButtonRef?: RefObject<HTMLButtonElement | null>;
};

function SidebarContent({
  guilds,
  guildId,
  guildsLoading,
  onSelectGuild,
  onClose,
  closeButtonRef,
}: SidebarContentProps) {
  const meQuery = useMe();
  const logout = useLogout();
  const { toast } = useToast();
  const me = meQuery.data;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 pt-5 pb-4">
        <Link
          to={withGuild("/", guildId)}
          className="flex min-w-0 items-center gap-2.5 rounded-lg"
          aria-label="Discord Music dashboard"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-accent/30 bg-accent/15 text-accent-strong">
            <LogoIcon className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold tracking-tight text-text">
              Discord Music
            </span>
            <span className="block text-xs text-muted">Remote control</span>
          </span>
        </Link>
        {onClose ? (
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="ml-auto rounded-md p-1.5 text-muted transition-colors hover:bg-white/5 hover:text-text"
          >
            <XIcon className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <div className="px-3 pb-4">
        {guildsLoading ? (
          <Skeleton className="h-[58px] w-full rounded-xl" />
        ) : (
          <GuildSwitcher guilds={guilds} guildId={guildId} onSelect={onSelectGuild} />
        )}
      </div>

      <nav aria-label="Main navigation" className="flex-1 space-y-1 overflow-y-auto px-3">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={withGuild(item.to, guildId)}
              end={item.end}
              onClick={() => onClose?.()}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent/15 text-accent-strong"
                    : "text-muted hover:bg-white/5 hover:text-text",
                )
              }
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          );
        })}
      </nav>

      <div className="mt-4 border-t border-border p-3">
        <div className="flex items-center gap-3 rounded-lg px-2 py-1.5">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-white/5 text-xs font-semibold text-text"
          >
            {me?.name.trim().charAt(0).toUpperCase() || "?"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-text">{me?.name ?? "Signed in"}</p>
            <p className="truncate text-xs text-muted">Administrator</p>
          </div>
          <button
            type="button"
            onClick={() =>
              logout.mutate(undefined, {
                onError: (error) => toast(getErrorMessage(error), "error"),
              })
            }
            disabled={logout.isPending}
            aria-label="Log out"
            title="Log out"
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-white/5 hover:text-text disabled:opacity-50"
          >
            <LogOutIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function AppShell(): ReactNode {
  const { guildId, guilds, selectGuild, isLoading } = useGuildSelection();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);

  useEffect(() => {
    if (drawerOpen) {
      drawerWasOpen.current = true;
      closeButtonRef.current?.focus();
      return;
    }
    if (drawerWasOpen.current) {
      drawerWasOpen.current = false;
      menuButtonRef.current?.focus();
    }
  }, [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawerOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [drawerOpen]);

  const selectedGuild = guilds.find((guild) => guild.id === guildId) ?? null;

  return (
    <div className="min-h-dvh bg-background text-text">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-background"
      >
        Skip to content
      </a>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 border-r border-border bg-surface md:block">
        <SidebarContent
          guilds={guilds}
          guildId={guildId}
          guildsLoading={isLoading}
          onSelectGuild={selectGuild}
        />
      </aside>

      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:hidden">
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          aria-controls={drawerOpen ? "mobile-navigation" : undefined}
          className="rounded-lg border border-border p-1.5 text-muted transition-colors hover:bg-white/5 hover:text-text"
        >
          <MenuIcon className="h-5 w-5" />
        </button>
        <Link
          to={withGuild("/", guildId)}
          className="flex items-center gap-2 rounded-lg"
          aria-label="Discord Music dashboard"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent/30 bg-accent/15 text-accent-strong">
            <LogoIcon className="h-4 w-4" />
          </span>
          <span className="text-sm font-semibold tracking-tight">Discord Music</span>
        </Link>
        {selectedGuild ? (
          <span className="ml-auto max-w-[45%] truncate text-xs text-muted">
            {selectedGuild.name}
          </span>
        ) : null}
      </header>

      {drawerOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/60"
          />
          <aside
            id="mobile-navigation"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface shadow-2xl shadow-black/50"
          >
            <SidebarContent
              guilds={guilds}
              guildId={guildId}
              guildsLoading={isLoading}
              onSelectGuild={(nextGuildId) => {
                selectGuild(nextGuildId);
                setDrawerOpen(false);
              }}
              onClose={() => setDrawerOpen(false)}
              closeButtonRef={closeButtonRef}
            />
          </aside>
        </div>
      ) : null}

      <div className="md:pl-72">
        <main
          id="main-content"
          className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
