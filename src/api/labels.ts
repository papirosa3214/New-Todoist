import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { ApiLabel } from "./types";

export function useLabels() {
  return useQuery({
    queryKey: ["labels"],
    queryFn: () => api.get<ApiLabel[]>("/api/labels"),
  });
}

export function useCreateLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; color?: string }) =>
      api.post<ApiLabel>("/api/labels", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["labels"] }),
  });
}

export function useDeleteLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ ok: boolean }>(`/api/labels/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["labels"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}
