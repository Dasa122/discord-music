/**
 * Route table and auth-routing rules.
 *
 * Kept free of React so the public/protected split can be unit-tested without
 * a DOM. `app.tsx` and `navigation.ts` consume the same path constants.
 */

export const ROUTE_PATHS = {
  landing: "/",
  login: "/login",
  forbidden: "/forbidden",
  dashboard: "/dashboard",
  queue: "/queue",
  downloads: "/downloads",
  playlists: "/playlists",
  playlistDetail: "/playlists/:id",
  history: "/history",
  settings: "/settings",
} as const;

/** Routes that never require a session. `*` is the router's catch-all. */
export const PUBLIC_ROUTES = [
  ROUTE_PATHS.landing,
  ROUTE_PATHS.login,
  ROUTE_PATHS.forbidden,
  "*",
] as const;

/** Routes rendered inside `RequireAuth` + `AppShell`. */
export const PROTECTED_ROUTES = [
  ROUTE_PATHS.dashboard,
  ROUTE_PATHS.queue,
  ROUTE_PATHS.playlists,
  ROUTE_PATHS.playlistDetail,
  ROUTE_PATHS.history,
  ROUTE_PATHS.downloads,
  ROUTE_PATHS.settings,
] as const;

/** Strips query/hash, collapses a trailing slash, and maps "" to "/". */
export function normalizePath(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0] ?? "";
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** Segment-wise match of a concrete path against a `/playlists/:id` pattern. */
function matchesPattern(path: string, pattern: string): boolean {
  const pathSegments = path.split("/").filter(Boolean);
  const patternSegments = pattern.split("/").filter(Boolean);
  if (pathSegments.length !== patternSegments.length) {
    return false;
  }
  return patternSegments.every((segment, index) =>
    segment.startsWith(":") ? segment.length > 1 : segment === pathSegments[index],
  );
}

export function isProtectedPath(path: string): boolean {
  const normalized = normalizePath(path);
  return PROTECTED_ROUTES.some((pattern) => matchesPattern(normalized, pattern));
}

type AuthRedirectInput = {
  authenticated: boolean;
  path: string;
};

/**
 * Client-side gate decision.
 *
 * - signed in on the landing page → dashboard
 * - signed out on a protected path → landing page
 * - everything else stays put (including `/login`, so no redirect loops)
 */
export function resolveAuthRedirect({ authenticated, path }: AuthRedirectInput): string | null {
  const normalized = normalizePath(path);
  if (authenticated && normalized === ROUTE_PATHS.landing) {
    return ROUTE_PATHS.dashboard;
  }
  if (!authenticated && isProtectedPath(normalized)) {
    return ROUTE_PATHS.landing;
  }
  return null;
}
