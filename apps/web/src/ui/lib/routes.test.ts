import { describe, expect, test } from "bun:test";
import { NAV_ITEMS } from "./navigation";
import {
  isProtectedPath,
  PROTECTED_ROUTES,
  PUBLIC_ROUTES,
  ROUTE_PATHS,
  resolveAuthRedirect,
} from "./routes";

describe("isProtectedPath", () => {
  test("protects every dashboard route", () => {
    expect(isProtectedPath(ROUTE_PATHS.dashboard)).toBe(true);
    expect(isProtectedPath(ROUTE_PATHS.queue)).toBe(true);
    expect(isProtectedPath(ROUTE_PATHS.playlists)).toBe(true);
    expect(isProtectedPath("/playlists/abc")).toBe(true);
    expect(isProtectedPath(ROUTE_PATHS.history)).toBe(true);
    expect(isProtectedPath(ROUTE_PATHS.downloads)).toBe(true);
    expect(isProtectedPath(ROUTE_PATHS.settings)).toBe(true);
  });

  test("leaves public and unknown routes public", () => {
    expect(isProtectedPath(ROUTE_PATHS.landing)).toBe(false);
    expect(isProtectedPath(ROUTE_PATHS.login)).toBe(false);
    expect(isProtectedPath(ROUTE_PATHS.forbidden)).toBe(false);
    expect(isProtectedPath("/does-not-exist")).toBe(false);
    expect(isProtectedPath("/dashboardish")).toBe(false);
    expect(isProtectedPath("/playlists/abc/extra")).toBe(false);
  });

  test("normalizes query strings, hashes, and trailing slashes", () => {
    expect(isProtectedPath("/dashboard?guild=1")).toBe(true);
    expect(isProtectedPath("/playlists/abc/")).toBe(true);
    expect(isProtectedPath("/queue#top")).toBe(true);
  });
});

describe("resolveAuthRedirect", () => {
  test("sends anonymous visitors from protected paths to the landing page", () => {
    expect(resolveAuthRedirect({ authenticated: false, path: ROUTE_PATHS.dashboard })).toBe(
      ROUTE_PATHS.landing,
    );
    expect(resolveAuthRedirect({ authenticated: false, path: "/playlists/abc" })).toBe(
      ROUTE_PATHS.landing,
    );
  });

  test("sends signed-in visitors from / to the dashboard", () => {
    expect(resolveAuthRedirect({ authenticated: true, path: ROUTE_PATHS.landing })).toBe(
      ROUTE_PATHS.dashboard,
    );
  });

  test("does not redirect anywhere else", () => {
    expect(resolveAuthRedirect({ authenticated: false, path: ROUTE_PATHS.landing })).toBeNull();
    expect(resolveAuthRedirect({ authenticated: false, path: ROUTE_PATHS.login })).toBeNull();
    expect(resolveAuthRedirect({ authenticated: true, path: ROUTE_PATHS.login })).toBeNull();
    expect(resolveAuthRedirect({ authenticated: true, path: ROUTE_PATHS.dashboard })).toBeNull();
    expect(resolveAuthRedirect({ authenticated: false, path: "/nope" })).toBeNull();
  });

  test("never loops for / or /login", () => {
    const chain = (path: string, authenticated: boolean) => {
      const next = resolveAuthRedirect({ authenticated, path });
      return next === null
        ? [path]
        : [path, next, resolveAuthRedirect({ authenticated, path: next })];
    };

    expect(chain(ROUTE_PATHS.landing, true)).toEqual([
      ROUTE_PATHS.landing,
      ROUTE_PATHS.dashboard,
      null,
    ]);
    expect(chain(ROUTE_PATHS.landing, false)).toEqual([ROUTE_PATHS.landing]);
    expect(chain(ROUTE_PATHS.login, true)).toEqual([ROUTE_PATHS.login]);
    expect(chain(ROUTE_PATHS.login, false)).toEqual([ROUTE_PATHS.login]);
  });
});

describe("route table", () => {
  test("public and protected sets are disjoint", () => {
    const publicPaths: readonly string[] = PUBLIC_ROUTES;
    const protectedPaths: readonly string[] = PROTECTED_ROUTES;
    const overlap = publicPaths.filter((path) => protectedPaths.includes(path));
    expect(overlap).toEqual([]);
  });

  test("public and protected sets cover every declared route", () => {
    const declared: string[] = [
      ROUTE_PATHS.landing,
      ROUTE_PATHS.login,
      ROUTE_PATHS.forbidden,
      "*",
      ...PROTECTED_ROUTES,
    ];
    const covered: string[] = [...PUBLIC_ROUTES, ...PROTECTED_ROUTES];
    expect(covered.sort()).toEqual(declared.sort());
  });
});

describe("navigation", () => {
  test("every nav item points at a protected path and none is /", () => {
    for (const item of NAV_ITEMS) {
      expect(item.to).not.toBe(ROUTE_PATHS.landing);
      expect(isProtectedPath(item.to)).toBe(true);
    }
  });

  test("nav labels stay unique", () => {
    const labels = NAV_ITEMS.map((item) => item.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
