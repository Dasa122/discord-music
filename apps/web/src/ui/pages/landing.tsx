import { Link, Navigate } from "react-router-dom";
import {
  ChevronRightIcon,
  DownloadIcon,
  ListIcon,
  LogoIcon,
  PlaylistIcon,
} from "../components/icons";
import { useMe } from "../lib/queries";
import { ROUTE_PATHS, resolveAuthRedirect } from "../lib/routes";

const FEATURES = [
  { icon: ListIcon, label: "Queue from Discord" },
  { icon: PlaylistIcon, label: "Playlists that persist" },
  { icon: DownloadIcon, label: "Live session downloads" },
] as const;

const REPO_URL = "https://github.com/Dasa122/discord-music";

/** Decorative only: no player state, no controls, no network requests. */
function HeroArt() {
  return (
    <div aria-hidden="true" className="relative mx-auto w-full max-w-md">
      <div className="absolute inset-0 -z-10 rounded-[2rem] bg-accent/10 blur-3xl" />
      <div className="rounded-2xl border border-border bg-surface p-6">
        <svg
          viewBox="0 0 320 200"
          className="h-auto w-full"
          fill="none"
          aria-hidden="true"
          focusable="false"
          role="presentation"
        >
          <defs>
            <linearGradient id="landing-bars" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" />
              <stop offset="100%" stopColor="var(--color-accent-strong)" />
            </linearGradient>
          </defs>
          <rect x="0.5" y="0.5" width="319" height="199" rx="16" stroke="var(--color-border)" />
          {[28, 54, 38, 72, 46, 88, 60, 34, 66, 44].map((height, index) => (
            <rect
              key={height}
              x={30 + index * 26}
              y={130 - height}
              width="12"
              height={height}
              rx="6"
              fill="url(#landing-bars)"
              opacity={0.35 + (index % 4) * 0.16}
            />
          ))}
          <circle cx="264" cy="52" r="24" stroke="var(--color-accent)" strokeOpacity="0.35" />
          <path
            d="M256 52h16M264 44v16"
            stroke="var(--color-accent-strong)"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M28 168h264"
            stroke="var(--color-border)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  );
}

export function LandingPage() {
  const { data: me } = useMe();
  const redirect = resolveAuthRedirect({
    authenticated: Boolean(me),
    path: ROUTE_PATHS.landing,
  });

  if (redirect) {
    return <Navigate to={redirect} replace />;
  }

  return (
    <div className="min-h-dvh bg-background text-text">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <a href={ROUTE_PATHS.landing} className="flex items-center gap-2.5 rounded-lg">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-accent/30 bg-accent/15 text-accent-strong">
              <LogoIcon className="h-5 w-5" />
            </span>
            <span className="text-sm font-semibold tracking-tight">Discord Music</span>
          </a>
          <a
            href="/api/auth/login"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-background transition-colors hover:bg-accent-strong"
          >
            Sign in
          </a>
        </div>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl gap-12 px-4 pt-14 pb-16 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:px-8 lg:pt-24">
          <div>
            <p className="text-xs font-medium tracking-[0.2em] text-accent uppercase">
              Discord music bot
            </p>
            <h1 className="mt-4 max-w-xl text-4xl font-semibold tracking-tight sm:text-5xl">
              Your server&apos;s music, without the babysitting.
            </h1>
            <p className="mt-5 max-w-lg text-base leading-relaxed text-muted">
              Queue tracks from Discord with <code className="text-text">/play</code> and control
              the player from your browser. No downloads, no streams, no tab left open.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                to={ROUTE_PATHS.login}
                className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-background transition-colors hover:bg-accent-strong"
              >
                Sign in with Authentik
              </Link>
              {me ? (
                <Link
                  to={ROUTE_PATHS.dashboard}
                  className="rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-text transition-colors hover:bg-white/5"
                >
                  Open dashboard
                </Link>
              ) : null}
            </div>
          </div>
          <HeroArt />
        </section>

        <section aria-label="Features" className="mx-auto max-w-6xl px-4 pb-16 sm:px-6 lg:px-8">
          <ul className="grid gap-3 sm:grid-cols-3">
            {FEATURES.map((feature) => {
              const Icon = feature.icon;
              return (
                <li
                  key={feature.label}
                  className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent/25 bg-accent/10 text-accent-strong">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-medium text-text">{feature.label}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-labelledby="how-it-works" className="border-y border-border bg-surface/60">
          <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
            <h2
              id="how-it-works"
              className="text-xs font-medium tracking-[0.2em] text-muted uppercase"
            >
              How it works
            </h2>
            <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-text">
              <code className="rounded-md border border-border bg-surface-raised px-2 py-1 font-medium text-accent-strong">
                /play
              </code>
              <span>in a voice channel</span>
              <ChevronRightIcon className="h-4 w-4 text-muted" />
              <span>the bot joins</span>
              <ChevronRightIcon className="h-4 w-4 text-muted" />
              <span>you control it here</span>
            </p>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-xs text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <p>
          Admin access is restricted to the Authentik{" "}
          <code className="text-text">music-admins</code> group.
        </p>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-accent underline-offset-4 hover:underline"
        >
          GitHub repository
        </a>
      </footer>
    </div>
  );
}
