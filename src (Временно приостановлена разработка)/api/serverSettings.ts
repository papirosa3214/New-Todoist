// MAK-95: API клиент для реестра серверных параметров.
// Соответствует server/src/routes/admin-server-settings.ts.
// Только владелец — на клиенте отдельной проверки нет, сервер отдаст 403.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

export type SettingKind =
  | "duration_min"
  | "duration_sec"
  | "duration_ms"
  | "interval_ms"
  | "int"
  | "bool"
  | "enum";

export type SettingGroup =
  | "тишина"
  | "перезапуски"
  | "расписания"
  | "снимки"
  | "автоимпорт"
  | "linear"
  | "таймауты"
  | "лимиты"
  | "режим_приёма";

export type ServerSetting = {
  key: string;
  label: string;
  group: SettingGroup;
  kind: SettingKind;
  default: number | boolean | string;
  min?: number;
  max?: number;
  options?: string[];
  applies_to: string[];
};

export type ServerSettingsPayload = {
  settings: ServerSetting[];
  values: Record<string, number | boolean | string>;
  updated_at: Record<string, string>;
};

export type ServerSettingsLog = {
  id: number;
  key: string;
  old_value: string | null;
  new_value: string;
  reason: string | null;
  actor_id: string | null;
  created_at: string;
};

export function useServerSettings() {
  return useQuery({
    queryKey: ["admin-server-settings"],
    queryFn: () => api.get<ServerSettingsPayload>("/api/admin/server-settings"),
  });
}

export function useUpdateServerSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      key,
      value,
      reason,
    }: {
      key: string;
      value: number | boolean | string;
      reason?: string;
    }) =>
      api.put<{ ok: true; value: unknown }>(
        `/api/admin/server-settings/${key}`,
        { value, reason },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-server-settings"] }),
  });
}

export function useResetServerSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, reason }: { key: string; reason?: string }) =>
      api.post<{ ok: true }>(
        `/api/admin/server-settings/${key}/reset`,
        reason ? { reason } : undefined,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-server-settings"] }),
  });
}

export function useServerSettingsLog() {
  return useQuery({
    queryKey: ["admin-server-settings-log"],
    queryFn: () =>
      api.get<{ log: ServerSettingsLog[] }>("/api/admin/server-settings/log"),
    // История нужна только при ручном открытии; по умолчанию экран её
    // не запрашивает — дёрнем через `enabled` по желанию.
  });
}