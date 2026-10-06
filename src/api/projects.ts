import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { ApiProject } from "./types";

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<ApiProject[]>("/api/projects"),
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; color?: string }) =>
      api.post<ApiProject>("/api/projects", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export interface UpdateProjectInput {
  id: string;
  // Раньше name было обязательным — PATCH умел только «переименовать» из
  // формы редактирования. С 20.08.2026 (закрепление/reorder проектов на
  // «Обзоре», server/src/routes/projects.ts) сервер принимает частичное
  // тело — name опционален и здесь тоже, иначе PATCH с одним только
  // position/pinned пришлось бы обходить этот хук.
  name?: string;
  color?: string;
  position?: number | null;
  pinned?: boolean;
  /** Папка заметок проекта; null — отвязать (26.08.2026). */
  notes_folder_id?: number | null;
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateProjectInput) =>
      api.patch<ApiProject>(`/api/projects/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ ok: boolean; archived?: boolean }>(`/api/projects/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["projects", "archive"] });
    },
  });
}

/** Архивный проект: список проектов из Архива (только владелец). */
export interface ArchivedProject extends ApiProject {
  archived_at: string;
  archived_by: string | null;
  active_count: number;
  docs_count: number;
  chat_count: number;
  memory_count: number;
}

export function useArchivedProjects() {
  return useQuery({
    queryKey: ["projects", "archive"],
    queryFn: () =>
      api.get<ArchivedProject[]>("/api/projects/archive"),
  });
}

/** Вернуть проект из архива (только владелец). */
export function useRestoreProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ ok: boolean; chats_reopened: boolean }>(`/api/projects/${id}/restore`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

/** Удалить проект навсегда (только владелец, только из архива). */
export function usePurgeProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, withDocs }: { id: string; withDocs?: boolean }) =>
      api.delete<{ ok: boolean; counts: Record<string, number> }>(
        `/api/projects/${id}/purge${withDocs ? "?with_docs=true" : ""}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}
