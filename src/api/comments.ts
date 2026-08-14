import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { ApiComment } from "./types";

export function useAddComment(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    // attachmentIds — файлы, загруженные до отправки (см. api/attachments.ts):
    // они лежат на сервере «ничьими», и этот запрос их подбирает. Пустой
    // текст допустим, когда файлы есть — «вот скриншот» без подписи.
    mutationFn: ({
      text,
      attachmentIds = [],
    }: {
      text: string;
      attachmentIds?: string[];
    }) =>
      api.post<ApiComment>(`/api/tasks/${taskId}/comments`, {
        text,
        attachment_ids: attachmentIds,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks", taskId] }),
  });
}
