import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { BrowserRouter, Route, Routes, useNavigate } from "react-router-dom";
import { AppShell } from "./components/app-shell";
import { Login } from "./components/login";
import { ToastProvider } from "./components/toast";
import { ApiError } from "./lib/api";
import { DashboardPage } from "./pages/dashboard";
import { ForbiddenPage } from "./pages/forbidden";
import { HistoryPage } from "./pages/history";
import { NotFoundPage } from "./pages/not-found";
import { PlaylistDetailPage } from "./pages/playlist-detail";
import { PlaylistsPage } from "./pages/playlists";
import { QueuePage } from "./pages/queue";
import { SettingsPage } from "./pages/settings";

function createQueryClient(navigate: (path: string) => void): QueryClient {
  const handleAuthError = (error: unknown) => {
    if (!(error instanceof ApiError)) {
      return;
    }
    if (error.status === 401) {
      window.location.assign("/api/auth/login");
      return;
    }
    if (error.status === 403 && window.location.pathname !== "/forbidden") {
      navigate("/forbidden");
    }
  };

  return new QueryClient({
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
}

function AppProviders() {
  const navigate = useNavigate();
  const [queryClient] = useState(() => createQueryClient(navigate));

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="queue" element={<QueuePage />} />
            <Route path="playlists" element={<PlaylistsPage />} />
            <Route path="playlists/:id" element={<PlaylistDetailPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
          <Route path="/login" element={<Login />} />
          <Route path="/forbidden" element={<ForbiddenPage />} />
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
