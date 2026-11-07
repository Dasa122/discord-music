import { Link, useSearchParams } from "react-router-dom";
import { ROUTE_PATHS } from "../lib/routes";
import { AlertTriangleIcon, LogoIcon } from "./icons";

/** Login card shown when the session is missing or the user signed out. */
export function Login() {
  const [searchParams] = useSearchParams();
  const error = searchParams.get("error");

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-accent/30 bg-accent/15 text-accent-strong">
            <LogoIcon className="h-5 w-5" />
          </span>
          <div>
            <p className="text-sm font-semibold tracking-tight text-text">Discord Music</p>
            <p className="text-xs text-muted">Remote control</p>
          </div>
        </div>

        <h1 className="mt-6 text-xl font-semibold tracking-tight text-text">
          Sign in to the dashboard
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          This dashboard controls the music bot inside your Discord server. Sign in with your
          Authentik account to continue.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Access requires membership in an administrator group configured by the server operator.
        </p>

        {error ? (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-muted"
          >
            <AlertTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
            <span>
              Sign-in failed ({error}). Try again, or ask an administrator to check your access.
            </span>
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => {
            window.location.href = "/api/auth/login";
          }}
          className="mt-5 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-background transition-colors hover:bg-accent-strong"
        >
          Sign in with Authentik
        </button>

        <p className="mt-4 text-xs leading-relaxed text-muted">
          Playback always happens in the Discord voice channel. This page never streams audio to
          your browser.
        </p>

        <Link
          to={ROUTE_PATHS.landing}
          className="mt-4 inline-block text-xs font-medium text-accent underline-offset-4 hover:underline"
        >
          Back to the home page
        </Link>
      </div>
    </main>
  );
}
