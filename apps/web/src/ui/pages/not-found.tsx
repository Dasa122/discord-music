import { Link } from "react-router-dom";
import { LogoIcon } from "../components/icons";

export function NotFoundPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 text-center">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-accent/30 bg-accent/15 text-accent-strong">
          <LogoIcon className="h-5 w-5" />
        </span>
        <h1 className="mt-4 text-xl font-semibold tracking-tight text-text">Page not found</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          This page does not exist. It may have been renamed, or the link is out of date.
        </p>
        <Link
          to="/"
          className="mt-5 inline-block rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-background transition-colors hover:bg-accent-strong"
        >
          Back to the dashboard
        </Link>
      </div>
    </main>
  );
}
