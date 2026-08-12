import { useMutation } from "@tanstack/react-query";
import { api } from "./client";

// Владелец подтверждает/правит список ПЕРЕД сохранением — эти запросы
// ничего не создают, только предлагают (см. TaskFormScreen).
interface SuggestSubtasksResponse {
  subtasks: string[];
}

// Существующая задача (уже есть id) — сервер сам подтягивает title/
// description из БД, но принимает их же в теле, если форма правится и ещё
// не сохранена (см. server/src/routes/ai.ts).
export function useSuggestSubtasksForTask(taskId: string) {
  return useMutation({
    mutationFn: (body: { title?: string; description?: string }) =>
      api.post<SuggestSubtasksResponse>(
        `/api/tasks/${taskId}/suggest-subtasks`,
        body,
      ),
  });
}

// Черновик — задача ещё не создана, id нет.
export function useSuggestSubtasksForDraft() {
  return useMutation({
    mutationFn: (body: { title: string; description?: string }) =>
      api.post<SuggestSubtasksResponse>("/api/ai/suggest-subtasks", body),
  });
}
