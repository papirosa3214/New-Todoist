// Оценщик JEV (TypeSafe) — отдельная категория настроек, не провайдер
// моделей ролей. Сервер: server/src/routes/jev.ts. Ключ сюда не приходит
// никогда — только признак hasApiKey.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

export interface JevSettings {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  hasApiKey: boolean;
  planProfileEnabled: boolean;
  planProfileMinConfidence: number;
  subtaskRoleEnabled: boolean;
  subtaskRoleMinConfidence: number;
  memoryRecallEnabled: boolean;
  memoryRecallMinConfidence: number;
  memoryWriteEnabled: boolean;
  memoryWriteMinConfidence: number;
  skillsEnabled: boolean;
  updatedAt: string;
}

export type JevSettingsInput = Partial<
  Omit<JevSettings, "hasApiKey" | "updatedAt">
> & { apiKey?: string };

export type JevTestResult =
  { ok: true; models: string[]; ms: number } | { ok: false; error: string };

const KEY = ["jev", "settings"];

export function useJevSettings() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<JevSettings>("/api/jev/settings"),
  });
}

export function useSaveJevSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: JevSettingsInput) =>
      api.put<JevSettings>("/api/jev/settings", input),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
}

export function useResetJevSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<JevSettings>("/api/jev/settings"),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
}

export function useTestJev() {
  return useMutation({
    mutationFn: () => api.post<JevTestResult>("/api/jev/test"),
  });
}
