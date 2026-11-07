import { Navigate, Outlet } from "react-router-dom";
import { useMe } from "../lib/queries";
import { ROUTE_PATHS } from "../lib/routes";
import { ErrorBanner } from "./error-banner";
import { Spinner } from "./spinner";

/**
 * Auth gate for the admin app.
 *
 * Nothing from `AppShell` (sidebar, guild switcher, player widgets) mounts
 * until `/api/me` has answered with a session. A 401 is data `null` (handled
 * by `useMe`), a 5xx or network failure is shown inline with a retry.
 */
export function RequireAuth() {
  const { data, isPending, isError, error, refetch } = useMe();

  if (isPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-4">
        <Spinner label="Checking your session…" />
      </main>
    );
  }

  if (isError) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-4">
        <div className="w-full max-w-md">
          <ErrorBanner
            error={error}
            title="Could not check your session"
            onRetry={() => {
              void refetch();
            }}
          />
        </div>
      </main>
    );
  }

  if (!data) {
    return <Navigate to={ROUTE_PATHS.landing} replace />;
  }

  return <Outlet />;
}
