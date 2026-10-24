import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

/**
 * ═══════════ Заметки ═══════════
 *
 * 26.08.2026. Самостоятельные заметки: своё название, сколько угодно в
 * день, лежат в папках (те же journal_folders — см. api/journal.ts).
 * Таблица на сервере — user_notes (имя notes занято старой заброшенной
 * таблицей из миграции 010).
 *
 * Список приходит БЕЗ контента, только с превью: иначе экран папки вёз бы
 * весь TipTap-JSON каждой заметки. Контент тянется отдельно при открытии.
 */

export interface ApiNote {
  id: string;
  title: string;
  content: string;
  folder_id: number | null;
  created_at: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

export interface ApiNoteSummary {
  id: string;
  title: string;
  folder_id: number | null;
  preview: string;
  created_at: string | null;
  updated_at: string | null;
}

export function useNotes() {
  return useQuery({
    queryKey: ["notes"],
    queryFn: () => api.get<{ notes: ApiNoteSummary[] }>("/api/notes"),
    staleTime: 30 * 1000,
  });
}

export function useNote(id: string) {
  return useQuery({
    queryKey: ["note", id],
    queryFn: () => api.get<ApiNote>(`/api/notes/${id}`),
    enabled: !!id,
  });
}

export function useCreateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      title?: string;
      content?: string;
      folder_id?: number | null;
    }) => api.post<ApiNote>("/api/notes", input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notes"] });
    },
  });
}

/** Частичное обновление: шлём только изменённые поля. */
export function useUpdateNote(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      title?: string;
      content?: string;
      folder_id?: number | null;
    }) => api.patch<ApiNote>(`/api/notes/${id}`, body),
    onSuccess: (note) => {
      qc.setQueryData(["note", id], note);
      qc.invalidateQueries({ queryKey: ["notes"] });
    },
  });
}

export function useDeleteNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/api/notes/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notes"] });
    },
  });
}

/**
 * Перенос заметки в папку. Кэш патчится синхронно — иначе заметка на
 * ~300мс пропадает со старого места и только потом появляется на новом
 * («моргнул — потом появился», тот же класс бага, что чинили в DayHours).
 */
export function useMoveNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      folder_id,
    }: {
      id: string;
      folder_id: number | null;
    }) => api.patch<ApiNote>(`/api/notes/${id}`, { folder_id }),
    onMutate: async ({ id, folder_id }) => {
      await qc.cancelQueries({ queryKey: ["notes"] });
      const prev = qc.getQueryData<{ notes: ApiNoteSummary[] }>(["notes"]);
      if (prev) {
        qc.setQueryData<{ notes: ApiNoteSummary[] }>(["notes"], {
          notes: prev.notes.map((n) =>
            n.id === id ? { ...n, folder_id } : n,
          ),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["notes"], ctx.prev);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notes"] });
    },
  });
}