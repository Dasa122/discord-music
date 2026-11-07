import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { BrowserRouter, Route, Routes, useNavigate } from "react-router-dom";
import { AppShell } from "./components/app-shell";
import { Login } from "./components/login";
import { RequireAuth } from "./components/require-auth";
import { ToastProvider } from "./components/toast";
import { ApiError, queryKeys } from "./lib/api";
import { ROUTE_PATHS } from "./lib/routes";
import { DashboardPage } from "./pages/dashboard";
import { DownloadsPage } from "./pages/downloads";
import { ForbiddenPage } from "./pages/forbidden";
import { HistoryPage } from "./pages/history";
import { LandingPage } from "./pages/landing";
import { NotFoundPage } from "./pages/not-found";
import { PlaylistDetailPage } from "./pages/playlist-detail";
import { PlaylistsPage } from "./pages/playlists";
import { QueuePage } from "./pages/queue";
import { SettingsPage } from "./pages/settings";

function createQueryClient(navigate: (path: string) => void): QueryClient {
  let queryClient: QueryClient;

  const handleAuthError = (error: unknown) => {
    if (!(error instanceof ApiError)) {
      return;
    }
    if (error.status === 401) {
      // A stale cookie should not bounce through SSO again: drop the cached
      // identity and show the public landing page.
      void queryClient.invalidateQueries({ queryKey: queryKeys.me() });
      navigate(ROUTE_PATHS.landing);
      return;
    }
    if (error.status === 403 && window.location.pathname !== ROUTE_PATHS.forbidden) {
      navigate(ROUTE_PATHS.forbidden);
    }
  };

  queryClient = new QueryClient({
    queryCache: new QueryCache({ onError: handleAuthError }),
    mutationCache: new MutationCache({ onError: handleAuthError }),
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
            return false;
          }
          return failureCount < 1;
        },
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });

  return queryClient;
}

function AppProviders() {
  const navigate = useNavigate();
  const [queryClient] = useState(() => createQueryClient(navigate));

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Routes>
          <Route path={ROUTE_PATHS.landing} element={<LandingPage />} />
          <Route path={ROUTE_PATHS.login} element={<Login />} />
          <Route path={ROUTE_PATHS.forbidden} element={<ForbiddenPage />} />
          <Route element={<RequireAuth />}>
            <Route element={<AppShell />}>
              <Route path={ROUTE_PATHS.dashboard} element={<DashboardPage />} />
              <Route path={ROUTE_PATHS.queue} element={<QueuePage />} />
              <Route path={ROUTE_PATHS.downloads} element={<DownloadsPage />} />
              <Route path={ROUTE_PATHS.playlists} element={<PlaylistsPage />} />
              <Route path={ROUTE_PATHS.playlistDetail} element={<PlaylistDetailPage />} />
              <Route path={ROUTE_PATHS.history} element={<HistoryPage />} />
              <Route path={ROUTE_PATHS.settings} element={<SettingsPage />} />
            </Route>
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </ToastProvider>
    </QueryClientProvider>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppProviders />
    </BrowserRouter>
  );
}
