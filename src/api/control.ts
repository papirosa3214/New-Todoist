// ═══════════ MAK-69 — управление сервером ═══════════
// Три хука под три эндпоинта control.ts (build): «прервать шаг»,
// «сбросить попытку», «отменить задание». Шаблон — useDeleteTask в
// api/tasks.ts: та же лента инвалидации ["tasks"], тот же onSuccess без
// сидинга кэша из ответа (WS `task:updated` привезёт свежий agent_state
// сам). `reason` — опциональный клиент, сервер сам режет до 200 символов
// (control.ts); обрезать на клиенте специально НЕ стали, чтобы не
// расходиться с серверным правилом и не показывать баннер «слишком
// длинная причина», которого нет.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

export function useCancelSubtask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post<{
        ok: boolean;
        subtaskId: string;
        aborted: boolean;
        attemptClosed: boolean;
        leaseReleased: boolean;
      }>(`/api/subtasks/${id}/cancel`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useResetSubtask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post<{
        ok: boolean;
        subtaskId: string;
        attemptClosed: boolean;
        leaseReleased: boolean;
      }>(`/api/subtasks/${id}/reset`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useCancelTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post<{
        ok: boolean;
        taskId: string;
        abortedRuns: number;
        attemptsClosed: number;
        leaseReleased: boolean;
      }>(`/api/tasks/${id}/cancel`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}
