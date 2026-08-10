import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { ApiNotification } from "./types";

export function useNotifications() {
  return useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<ApiNotification[]>("/api/notifications"),
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.patch<{ ok: boolean }>(`/api/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/api/notifications/read-all"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

// `created_at` is SQLite's `datetime('now')`: "YYYY-MM-DD HH:MM:SS" in UTC
// with no timezone marker. `new Date(...)` would parse that as *local*
// time, which is 3h off in Moscow. Normalize before parsing.
export function parseServerDate(sqliteDatetime: string): Date {
  return new Date(sqliteDatetime.replace(" ", "T") + "Z");
}

export function formatRelativeTime(sqliteDatetime: string): string {
  const d = parseServerDate(sqliteDatetime);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "только что";
  if (diffMin < 60) return `${diffMin} мин. назад`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH} ч. назад`;
  const diffD = Math.round(diffH / 24);
  if (diffD === 1) return "вчера";
  return `${diffD} дн. назад`;
}
