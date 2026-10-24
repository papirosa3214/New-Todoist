import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

/**
 * ═══════════ Папки заметок ═══════════
 *
 * Папки древовидные, заметка лежит ровно в одной (или ни в одной —
 * тогда она в корне). Миграция 012_journal_folders.
 *
 * Файл назывался journal.ts и держал ещё и записи Дневника по дням —
 * «одна дата = одна запись». 26.08.2026 та сущность удалена целиком:
 * заметки стали самостоятельными (api/notes.ts), а Дневник по дням остался
 * без единого входа и дублировал их. Единственная его запись перенесена
 * в заметки миграцией 013_user_notes. Имена роутов /api/journal/folders и
 * ключи кэша journal-folders сохранены — переименование ради красоты
 * стоило бы миграции и сломанных ссылок.
 */

export interface ApiJournalFolder {
  id: number;
  parent_id: number | null;
  name: string;
  position: number;
}

export function useJournalFolders() {
  return useQuery({
    queryKey: ["journal-folders"],
    queryFn: () => api.get<{ folders: ApiJournalFolder[] }>("/api/journal/folders"),
    staleTime: 30 * 1000,
  });
}

interface CreateFolderInput {
  name: string;
  parent_id?: number | null;
  position?: number;
}

export function useCreateJournalFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFolderInput) =>
      api.post<{ folder: ApiJournalFolder }>("/api/journal/folders", input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journal-folders"] });
    },
  });
}

interface UpdateFolderInput {
  id: number;
  name?: string;
  parent_id?: number | null;
  position?: number;
}

export function useUpdateJournalFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateFolderInput) =>
      api.patch<{ folder: ApiJournalFolder }>(`/api/journal/folders/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journal-folders"] });
    },
  });
}

export function useDeleteJournalFolder() {
  const qc = useQueryClient();
  return useMutation({
    // 204 No Content → request() отдаёт null; типизируем как unknown,
    // чтобы не зависеть от точной формы пустого ответа.
    mutationFn: (id: number) =>
      api.delete<unknown>(`/api/journal/folders/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journal-folders"] });
      // Заметки из удалённой папки «выпадают» в корень (ON DELETE SET NULL
      // на сервере) — список заметок должен это видеть.
      qc.invalidateQueries({ queryKey: ["notes"] });
    },
  });
}

/**
 * Перенести папку внутрь другой (или в корень: parent_id = null).
 * Сервер сам отбивает циклы (нельзя положить папку внутрь её потомка).
 *
 * onMutate патчит кэш СИНХРОННО: без этого папка на ~300мс исчезает со
 * старого места и только потом появляется на новом («моргнул — потом
 * появился», тот же класс бага, что чинили в DayHours 26.08.2026).
 */
export function useMoveJournalFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      parent_id,
    }: {
      id: number;
      parent_id: number | null;
    }) =>
      api.patch<{ folder: ApiJournalFolder }>(`/api/journal/folders/${id}`, {
        parent_id,
      }),
    onMutate: async ({ id, parent_id }) => {
      await qc.cancelQueries({ queryKey: ["journal-folders"] });
      const prev = qc.getQueryData<{ folders: ApiJournalFolder[] }>([
        "journal-folders",
      ]);
      if (prev) {
        qc.setQueryData<{ folders: ApiJournalFolder[] }>(["journal-folders"], {
          folders: prev.folders.map((f) =>
            f.id === id ? { ...f, parent_id } : f,
          ),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["journal-folders"], ctx.prev);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journal-folders"] });
    },
  });
}