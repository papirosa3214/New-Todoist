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
      api.delete<{ ok: boolean }>(`/api/projects/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}
