import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
//
// source — 18.08.2026, следующая просьба: «а как понять, что реально
// работает через Apple Intelligence» — возвращаем источник явно,
// TaskFormScreen показывает его короткой подписью (см. audio.ts —
// тот же паттерн, та же причина).
type SuggestResult = SuggestSubtasksResponse & { source: "device" | "server" };

export function useSuggestSubtasksForTask(taskId: string) {
  return useMutation({
    mutationFn: async (body: {
      title?: string;
      description?: string;
    }): Promise<SuggestResult> => {
      if (body.title) {
        const onDevice = await suggestSubtasksOnDevice(
          draftText(body.title, body.description),
        );
        if (onDevice) return { subtasks: onDevice, source: "device" };
      }
      const server = await api.post<SuggestSubtasksResponse>(
        `/api/tasks/${taskId}/suggest-subtasks`,
        body,
      );
      return { ...server, source: "server" };
    },
  });
}

// Черновик — задача ещё не создана, id нет.
export function useSuggestSubtasksForDraft() {
  return useMutation({
    mutationFn: async (body: {
      title: string;
      description?: string;
    }): Promise<SuggestResult> => {
      const onDevice = await suggestSubtasksOnDevice(
        draftText(body.title, body.description),
      );
      if (onDevice) return { subtasks: onDevice, source: "device" };
      const server = await api.post<SuggestSubtasksResponse>(
        "/api/ai/suggest-subtasks",
        body,
      );
      return { ...server, source: "server" };
    },
  });
}

export interface StructuredTask {
  title: string;
  description: string;
  subtasks: string[];
  dueDate: string | null;
  priority: number;
}

export function useStructureTaskWithAI() {
  return useMutation({
    mutationFn: async (text: string): Promise<StructuredTask> => {
      return await api.post<StructuredTask>("/api/ai/structure-task", { text });
    },
  });
}

export interface WeeklySummary {
  greeting: string;
  accomplishments: string[];
  missed_or_overdue: string[];
  next_week_focus: string[];
  productivity_score: number;
  stats: {
    completed_count: number;
    overdue_count: number;
    active_count: number;
  };
  generated_at: string;
}

export function useWeeklySummary() {
  return useQuery({
    queryKey: ["weekly-summary"],
    queryFn: async (): Promise<WeeklySummary> => {
      return await api.get<WeeklySummary>("/api/ai/weekly-summary");
    },
    staleTime: 10 * 60 * 1000,
  });
}

export function useRefreshWeeklySummary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<WeeklySummary> => {
      return await api.post<WeeklySummary>("/api/ai/weekly-summary/refresh");
    },
    onSuccess: (data) => {
      qc.setQueryData(["weekly-summary"], data);
    },
  });
}

export interface OllamaModelInfo {
  name: string;
  size: number;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

// ═══════════ Дневник: AI-действия + мост в задачи ═══════════
export type JournalAssistAction = "continue" | "shorten" | "expand";

export function useJournalAssist() {
  return useMutation({
    mutationFn: async (body: {
      text: string;
      action: JournalAssistAction;
    }): Promise<{ result: string }> => {
      return await api.post<{ result: string }>("/api/ai/journal-assist", body);
    },
  });
}

export interface ExtractedTask {
  title: string;
  description: string;
  priority: number;
  due_date: string | null;
}

export function useExtractTasksFromText() {
  return useMutation({
    mutationFn: async (text: string): Promise<{ tasks: ExtractedTask[] }> => {
      return await api.post<{ tasks: ExtractedTask[] }>(
        "/api/ai/extract-tasks",
        { text },
      );
    },
  });
}

export function useLocalOllamaModels() {
  return useQuery({
    queryKey: ["local-ollama-models"],
    queryFn: async (): Promise<{ models: OllamaModelInfo[] }> => {
      return await api.get<{ models: OllamaModelInfo[] }>(
        "/api/ai/local-models",
      );
    },
    staleTime: 60 * 1000,
  });
}
