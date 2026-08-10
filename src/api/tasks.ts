import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { ApiTask } from "./types";

export function useTasks() {
  return useQuery({
    queryKey: ["tasks"],
    queryFn: () => api.get<ApiTask[]>("/api/tasks"),
  });
}

// Missing/inaccessible task (not creator or assignee) → 404, which the
// fetch layer turns into a thrown ApiError, so this query goes to isError
// with `data` undefined. Callers should key their "not found" UI off that,
// not off a response field.
export function useTask(id: string | undefined) {
  return useQuery({
    queryKey: ["tasks", id],
    queryFn: () => api.get<ApiTask>(`/api/tasks/${id}`),
    enabled: !!id,
    retry: false,
  });
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  due_date?: string;
  project_id?: string;
  priority?: number;
  assignee_id?: string;
  label_ids?: string[];
  // Created atomically with the task in one transaction (server-side —
  // see AGENT-API.md §Tasks) — either a plain title or `{ title }`.
  subtasks?: (string | { title: string })[];
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTaskInput) =>
      api.post<{ task: ApiTask }>("/api/tasks", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export interface UpdateTaskInput {
  id: string;
  title?: string;
  description?: string;
  due_date?: string | null;
  project_id?: string | null;
  priority?: number;
  assignee_id?: string | null;
  status?: "active" | "completed";
  label_ids?: string[];
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateTaskInput) =>
      api.patch<{ task: ApiTask }>(`/api/tasks/${id}`, body),
    onSuccess: () => {
      // The response is the raw row with no labels/subtasks/joins —
      // refetch instead of seeding the cache from it.
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/tasks/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}
