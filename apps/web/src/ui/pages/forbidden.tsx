import { Link } from "react-router-dom";
import { AlertTriangleIcon } from "../components/icons";

export function ForbiddenPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 text-center">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-danger/30 bg-danger/10 text-danger">
          <AlertTriangleIcon className="h-5 w-5" />
        </span>
        <h1 className="mt-4 text-xl font-semibold tracking-tight text-text">
          You do not have access
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          This dashboard requires membership in the Authentik group{" "}
          <code className="rounded bg-white/5 px-1">music-admins</code>. Ask an administrator to add
          your account, then sign in again.
        </p>

        <div className="mt-5 flex flex-col gap-2">
          <a
            href="/api/auth/login"
            className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-background transition-colors hover:bg-accent-strong"
          >
            Sign in again
          </a>
          <Link
            to="/"
            className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-text transition-colors hover:bg-white/5"
          >
            Back to the dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
