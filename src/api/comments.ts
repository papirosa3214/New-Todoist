import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { ApiComment } from "./types";

export function useAddComment(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) =>
      api.post<ApiComment>(`/api/tasks/${taskId}/comments`, { text }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks", taskId] }),
  });
}
