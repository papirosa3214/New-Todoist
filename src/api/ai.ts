import { useMutation } from "@tanstack/react-query";
import { api } from "./client";
import { suggestSubtasksOnDevice } from "../lib/localAI";

// Владелец подтверждает/правит список ПЕРЕД сохранением — эти запросы
// ничего не создают, только предлагают (см. TaskFormScreen).
interface SuggestSubtasksResponse {
  subtasks: string[];
}

function draftText(title?: string, description?: string): string {
  return description ? `${title ?? ""}\n\n${description}` : (title ?? "");
}

// Существующая задача (уже есть id) — сервер сам подтягивает title/
// description из БД, но принимает их же в теле, если форма правится и ещё
// не сохранена (см. server/src/routes/ai.ts).
//
// On-device первым (18.08.2026, «мне задержка не нравится очень долгая») —
// suggestSubtasksOnDevice сама возвращает null и при недоступности
// (не iOS/нет Apple Intelligence), и при сбое самого вызова (см. её
// комментарий в lib/localAI.ts) — в обоих случаях просто падаем на сервер
// как раньше, здесь этот выбор не различать. Без title не разобрать
// текст вовсе — на on-device пути он обязателен явно.
export function useSuggestSubtasksForTask(taskId: string) {
  return useMutation({
    mutationFn: async (body: { title?: string; description?: string }) => {
      if (body.title) {
        const onDevice = await suggestSubtasksOnDevice(
          draftText(body.title, body.description),
        );
        if (onDevice) return { subtasks: onDevice };
      }
      return api.post<SuggestSubtasksResponse>(
        `/api/tasks/${taskId}/suggest-subtasks`,
        body,
      );
    },
  });
}

// Черновик — задача ещё не создана, id нет.
export function useSuggestSubtasksForDraft() {
  return useMutation({
    mutationFn: async (body: { title: string; description?: string }) => {
      const onDevice = await suggestSubtasksOnDevice(
        draftText(body.title, body.description),
      );
      if (onDevice) return { subtasks: onDevice };
      return api.post<SuggestSubtasksResponse>(
        "/api/ai/suggest-subtasks",
        body,
      );
    },
  });
}
