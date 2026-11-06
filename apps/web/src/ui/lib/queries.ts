import type { GuildSettingsUpdate } from "@music/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type GuildActionBody, queryKeys } from "./api";

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me(),
    queryFn: api.me,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useGuilds() {
  return useQuery({
    queryKey: queryKeys.guilds(),
    queryFn: api.guilds,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

export function usePlayerState(guildId: string | null) {
  return useQuery({
    queryKey: queryKeys.state(guildId),
    queryFn: () => api.state(guildId as string),
    enabled: Boolean(guildId),
    refetchInterval: 2_000,
  });
}

export function useSettings(guildId: string | null) {
  return useQuery({
    queryKey: queryKeys.settings(guildId),
    queryFn: () => api.settings(guildId as string),
    enabled: Boolean(guildId),
  });
}

export function usePlaylists(guildId: string | null) {
  return useQuery({
    queryKey: queryKeys.playlists(guildId),
    queryFn: () => api.playlists(guildId as string),
    enabled: Boolean(guildId),
  });
}

export function usePlaylist(playlistId: string | null) {
  return useQuery({
    queryKey: queryKeys.playlist(playlistId),
    queryFn: () => api.playlist(playlistId as string),
    enabled: Boolean(playlistId),
  });
}

export function useHistory(guildId: string | null, page: number, pageSize = 25) {
  const safePage = Math.max(1, Math.round(page));
  return useQuery({
    queryKey: queryKeys.history(guildId, safePage),
    queryFn: () => api.history(guildId as string, pageSize, (safePage - 1) * pageSize),
    enabled: Boolean(guildId),
    placeholderData: keepPreviousData,
  });
}

/** Sends a player action and writes the returned state straight into the cache. */
export function useGuildAction(guildId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: GuildActionBody) => api.action(guildId as string, body),
    onSuccess: (state) => {
      queryClient.setQueryData(queryKeys.state(guildId), state);
      void queryClient.invalidateQueries({ queryKey: queryKeys.guilds() });
    },
  });
}

export function useUpdateSettings(guildId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: GuildSettingsUpdate) => api.updateSettings(guildId as string, body),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.settings(guildId), settings);
    },
  });
}

export function useCreatePlaylist(guildId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: { name: string; isShared?: boolean }) =>
      api.createPlaylist(guildId as string, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.playlists(guildId) });
    },
  });
}

export function useUpdatePlaylist(guildId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      playlistId,
      ...body
    }: {
      playlistId: string;
      name?: string;
      isShared?: boolean;
    }) => api.updatePlaylist(playlistId, body),
    onSuccess: (_playlist, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.playlists(guildId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.playlist(variables.playlistId) });
    },
  });
}

export function useDeletePlaylist(guildId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (playlistId: string) => api.deletePlaylist(playlistId),
    onSuccess: (_data, playlistId) => {
      queryClient.removeQueries({ queryKey: queryKeys.playlist(playlistId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.playlists(guildId) });
    },
  });
}

export function useRemovePlaylistItem(playlistId: string, guildId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (itemId: string) => api.removePlaylistItem(playlistId, itemId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.playlist(playlistId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.playlists(guildId) });
    },
  });
}

export function useReorderPlaylist(playlistId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (itemIds: string[]) => api.reorderPlaylist(playlistId, itemIds),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.playlist(playlistId) });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.clear();
      window.location.assign("/login");
    },
  });
}
