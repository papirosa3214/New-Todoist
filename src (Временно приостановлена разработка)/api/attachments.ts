import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { ApiAttachment } from "./types";

// Файл уходит сырыми байтами — тем же способом, что запись микрофона
// (api/audio.ts, api.postBlob): фронт и так держит File, а multipart здесь
// ничего не добавляет. Имя едет в query закодированным: в нём бывают
// пробелы и кириллица, а в заголовке они превратились бы в мусор.
export function useUploadAttachment(taskId: string) {
  return useMutation({
    mutationFn: (file: File) => uploadAttachment(taskId, file, "comment"),
  });
}

/**
 * Файл САМОЙ задачи — то, что прикладывается к её заметке, а не пишется
 * комментарием в ленту (19.08.2026).
 *
 * Отдельный вид, а не «комментарий без текста»: такие файлы висят в карточке
 * под описанием и в ленте не появляются. Сервер различает их по `kind` — см.
 * миграцию 006_attachment_kind.
 *
 * Кэш задачи инвалидируется здесь же: список вложений приезжает с самой
 * задачей (GET /api/tasks/:id), и без этого приложенный файл не появился бы
 * в карточке до перезагрузки.
 */
export function useUploadTaskAttachment(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => uploadAttachment(taskId, file, "task"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks", taskId] }),
  });
}

/**
 * Отправка одного файла. Вынесена из хуков, чтобы её можно было вызвать и
 * вне React Query — форма создания задачи грузит файлы уже ПОСЛЕ того, как
 * задача создана (до этого момента её идентификатора попросту нет), в
 * обычном цикле, а не мутацией на каждый файл.
 */
export function uploadAttachment(
  taskId: string,
  file: File,
  kind: "task" | "comment" = "comment",
): Promise<{ attachment: ApiAttachment }> {
  return api.postBlob<{ attachment: ApiAttachment }>(
    `/api/tasks/${taskId}/attachments?name=${encodeURIComponent(file.name)}&kind=${kind}`,
    file,
  );
}

// Убрать уже загруженный, но ещё не отправленный файл — когда человек
// передумал до отправки комментария. Файл удаляется и с диска (сервер),
// поэтому «передумал» не оставляет за собой мусора.
export function useDeleteAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ ok: true }>(`/api/attachments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

/** Путь для показа и скачивания. Требует того же токена, что и остальной API. */
export function attachmentUrl(id: string): string {
  return `/api/attachments/${id}`;
}
