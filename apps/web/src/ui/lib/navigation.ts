import { ROUTE_PATHS } from "./routes";

export type NavItem = {
  to: string;
  label: string;
  end: boolean;
};

/** Sidebar entries. Every target is a protected route; none is the landing page. */
export const NAV_ITEMS = [
  { to: ROUTE_PATHS.dashboard, label: "Dashboard", end: true },
  { to: ROUTE_PATHS.queue, label: "Queue", end: false },
  { to: ROUTE_PATHS.downloads, label: "Downloads", end: false },
  { to: ROUTE_PATHS.playlists, label: "Playlists", end: false },
  { to: ROUTE_PATHS.history, label: "History", end: false },
  { to: ROUTE_PATHS.settings, label: "Settings", end: false },
] as const satisfies readonly NavItem[];
