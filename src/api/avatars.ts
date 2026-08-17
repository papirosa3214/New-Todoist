import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

// Сырыми байтами — тот же приём, что и вложения (api/attachments.ts) и
// запись микрофона (api/audio.ts): фронт держит File, лишняя multipart-
// обёртка ничего не даёт. userId — свой или агента, которым управляешь
// (см. права в server/src/routes/avatars.ts: свой аккаунт, свой агент
// через created_by, либо системный бот).
export function useUploadAvatar(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) =>
      api.postBlob<{ avatar_url: string }>(`/api/users/${userId}/avatar`, file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useDeleteAvatar(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<{ ok: true }>(`/api/users/${userId}/avatar`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}
