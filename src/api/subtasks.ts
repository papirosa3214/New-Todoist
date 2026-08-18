import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { ApiSubtask } from "./types";

// Plain (non-hook) request, for call sites that need to fire this inside a
// loop/event handler rather than during render (e.g. TaskFormScreen's
// create mode, posting several subtasks right after the parent task itself
// is created — the server's POST /api/tasks has no bulk-subtask param, see
// CreateTaskInput).
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
      position?: number;
    }) => api.patch<ApiSubtask>(`/api/subtasks/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

// POST /api/subtasks/:id/work — то же самое, чем агент отмечает своё
// продвижение по шагу (server/src/routes/subtasks.ts), но здесь только
// владельческая половина: «Вернуть на доработку» (state: null + result —
// сервер требует комментарий у входа в review, но возврат наоборот пишет
// свой текст в result, перезаписывая итог агента объяснением, что не так).
// Агент делает то же самое действие через MCP (taskflow_subtask_work), не
// через этот хук — фронт подзадач открывает только владелец.
export function useSubtaskWork() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      state,
      result,
    }: {
      id: string;
      state: "in_progress" | "blocked" | "review" | null;
      result?: string;
    }) => api.post<ApiSubtask>(`/api/subtasks/${id}/work`, { state, result }),
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
