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

export interface UpdateLabelInput {
  id: string;
  // Server rejects a PATCH whose body has no `name` at all (falls back to
  // "" and 400s "Укажите название метки") — unlike /api/projects/:id,
  // which reuses the existing name when omitted. So callers must always
  // send the current (possibly unchanged) name, even for a color-only
  // recolor — see LabelsScreen's row save, which always sends both.
  name: string;
  color?: string;
}

export function useUpdateLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateLabelInput) =>
      api.patch<ApiLabel>(`/api/labels/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["labels"] });
      // A label's name/color render inline on task chips (TaskFields'
      // LabelsField, task cards, …) wherever it's already loaded there.
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
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
