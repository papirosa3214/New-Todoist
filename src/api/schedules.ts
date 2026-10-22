// Клиент рутин (крон-задач) — /api/schedules.
//
// Контракт — из заметки «Рутины и расписание TaskFlow», раздел «6. API».
// Форма экрана: «Мои рутины» (screens/RoutinesScreen.tsx).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

export type ScheduleRuleKind =
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "weekly_days"
  | "interval";

export interface ApiSchedulePayload {
  title: string;
  description?: string | null;
  project_id?: string | null;
  /** Роль-исполнитель (ключ роли). */
  assignee_id?: string | null;
  priority?: number | null;
  duration_min?: number | null;
  labels?: string[] | null;
  requires_reviewer_review?: boolean | null;
  needs_research?: boolean | null;
}

export interface ApiSchedule {
  id: string;
  title: string;
  task_payload: ApiSchedulePayload;
  rule_kind: ScheduleRuleKind;
  rule_expr: string | null;
  /** Подпись правила по-русски приходит с сервера — веб и iOS берут одно и то же. */
  rule_label: string;
  time_local: string;
  timezone: string;
  next_run_at: string | null;
  last_run_at: string | null;
  status: "active" | "paused" | "finished";
  catch_up: boolean;
  overlap_policy: "skip" | "allow";
  current_task_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiScheduleRun {
  id: string;
  schedule_id: string;
  run_at: string;
  task_id: string | null;
  status: "created" | "skipped" | "failed" | "error";
  detail: string | null;
  created_at: string;
}

export function useSchedules() {
  return useQuery({
    queryKey: ["schedules"],
    queryFn: () => api.get<{ schedules: ApiSchedule[] }>("/api/schedules"),
  });
}

/** Превью правила: ближайший запуск и подпись — считает сервер. */
export function useSchedulePreview(params: {
  rule_kind: ScheduleRuleKind;
  rule_expr?: string | null;
  time_local?: string;
  timezone?: string;
  enabled: boolean;
}) {
  const { rule_kind, rule_expr, time_local, timezone, enabled } = params;
  return useQuery({
    queryKey: ["schedules", "preview", rule_kind, rule_expr ?? "", time_local ?? "", timezone ?? ""],
    queryFn: () => {
      const query = new URLSearchParams({ rule_kind });
      if (rule_expr) query.set("rule_expr", rule_expr);
      if (time_local) query.set("time_local", time_local);
      if (timezone) query.set("timezone", timezone);
      return api.get<{ next_run_at: string | null; timezone: string; rule_label: string }>(
        `/api/schedules/preview?${query.toString()}`,
      );
    },
    enabled,
  });
}

export function useScheduleRuns(id: string | null) {
  return useQuery({
    queryKey: ["schedules", id, "runs"],
    queryFn: () => api.get<{ runs: ApiScheduleRun[] }>(`/api/schedules/${id}/runs`),
    enabled: Boolean(id),
  });
}

export interface CreateScheduleInput {
  title: string;
  rule_kind: ScheduleRuleKind;
  rule_expr?: string | null;
  time_local?: string;
  timezone?: string;
  catch_up?: boolean;
  overlap_policy?: "skip" | "allow";
  task_payload: ApiSchedulePayload;
}

export function useCreateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateScheduleInput) =>
      api.post<{ schedule: ApiSchedule }>("/api/schedules", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  });
}

export function useUpdateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Partial<CreateScheduleInput> & { status?: ApiSchedule["status"] }) =>
      api.patch<{ schedule: ApiSchedule }>(`/api/schedules/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      qc.invalidateQueries({ queryKey: ["schedules", null, "runs"] });
    },
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/schedules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  });
}

export function useRunScheduleNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{
        ok: boolean;
        counts: { created: number };
        run: {
          id: string;
          run_at: string;
          task_id: string | null;
          status: string;
          /** Причина пропуска или ошибки — её показываем пользователю. */
          detail: string | null;
        } | null;
      }>(`/api/schedules/${id}/run-now`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      qc.invalidateQueries({ queryKey: ["schedules", null, "runs"] });
    },
  });
}
