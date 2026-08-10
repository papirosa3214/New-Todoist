import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { ApiSubtask } from "./types";

// Plain (non-hook) request, for call sites that need to fire this inside a
// loop/event handler rather than during render (e.g. NewTaskScreen creating
// several subtasks right after the parent task itself is created — the
// server's POST /api/tasks has no bulk-subtask param, see CreateTaskInput).
export function createSubtaskRequest(taskId: string, title: string) {
  return api.post<ApiSubtask>(`/api/tasks/${taskId}/subtasks`, { title });
}

export function useCreateSubtask(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => createSubtaskRequest(taskId, title),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useUpdateSubtask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      done?: boolean;
      title?: string;
    }) => api.patch<ApiSubtask>(`/api/subtasks/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useDeleteSubtask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ ok: boolean }>(`/api/subtasks/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}
