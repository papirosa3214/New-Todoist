import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { ApiAttachment } from "./types";

// Файл уходит сырыми байтами — тем же способом, что запись микрофона
// (api/audio.ts, api.postBlob): фронт и так держит File, а multipart здесь
// ничего не добавляет. Имя едет в query закодированным: в нём бывают
// пробелы и кириллица, а в заголовке они превратились бы в мусор.
export function useUploadAttachment(taskId: string) {
  return useMutation({
    mutationFn: (file: File) =>
      api.postBlob<{ attachment: ApiAttachment }>(
        `/api/tasks/${taskId}/attachments?name=${encodeURIComponent(file.name)}`,
        file,
      ),
  });
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
