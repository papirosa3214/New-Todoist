import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { AgentState, ApiTask } from "./types";
import { AppleIntegrations } from "../lib/appleIntegrations";

export function useTasks() {
  return useQuery({
    queryKey: ["tasks"],
    queryFn: () => api.get<ApiTask[]>("/api/tasks"),
  });
}

// Missing/inaccessible task (not creator or assignee) → 404, which the
// fetch layer turns into a thrown ApiError, so this query goes to isError
// with `data` undefined. Callers should key their "not found" UI off that,
// not off a response field.
export function useTask(id: string | undefined) {
  return useQuery({
    queryKey: ["tasks", id],
    queryFn: () => api.get<ApiTask>(`/api/tasks/${id}`),
    enabled: !!id,
    retry: false,
  });
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  due_date?: string;
  // Час начала «ЧЧ:ММ» и длительность в минутах — только вместе со сроком,
  // сервер отвергает время без даты (миграция 005_task_time_of_day).
  start_time?: string | null;
  duration_min?: number | null;
  // Повтор (миграция 049): сервер принимает только
  // none|daily|weekdays|weekly|monthly, дата — «ГГГГ-ММ-ДД».
  run_repeat?: string;
  repeat_until?: string | null;
  project_id?: string;
  priority?: number;
  assignee_id?: string;
  requires_reviewer_review?: boolean;
  label_ids?: string[];
  // Created atomically with the task in one transaction (server-side —
  // see AGENT-API.md §Tasks) — either a plain title or `{ title }`.
  subtasks?: (string | { title: string })[];
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTaskInput) =>
      api.post<{ task: ApiTask }>("/api/tasks", body),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      if (data?.task) {
        AppleIntegrations.syncTaskToApple(data.task);
      }
    },
  });
}

export interface UpdateTaskInput {
  id: string;
  title?: string;
  description?: string;
  due_date?: string | null;
  start_time?: string | null;
  duration_min?: number | null;
  // Повтор (миграция 049): «none» снимает серию, repeat_until — до когда.
  run_repeat?: string;
  repeat_until?: string | null;
  project_id?: string | null;
  priority?: number;
  assignee_id?: string | null;
  status?: "active" | "completed";
  label_ids?: string[];
  position?: number | null;
  pinned?: boolean;
  requires_reviewer_review?: boolean;
  // Готовность к самозахвату (миграция 026). На сервере поднимает только
  // владелец, так что здесь тип широкий, а проверка прав — в routes/tasks.ts.
  ready_for_pickup?: boolean;
  // «Нужно глубокое исследование» (миграция 052) — обычное поле карточки.
  needs_research?: boolean;
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateTaskInput) =>
      api.patch<{ task: ApiTask }>(`/api/tasks/${id}`, body),
    // Оптимистичный апдейт (26.08.2026, Максим): при перетаскивании
    // задачи в сетке часов DayHours плашка-источник прячется по `hidden`
    // сразу, как только React видит `dragging=null` в новом рендере
    // (т.е. после отпускания). До этого момента данные в кэше не
    // переехали — задача на старом месте уже скрыта, на новом ещё
    // не появилась, и пользователь видит пустое место, потом
    // появляется задача. «Моргнул — потом появился».
    //
    // В onMutate ПАТЧИМ кэш ["tasks"] синхронно, до ответа сервера:
    // задача сразу едет на новые due_date/start_time, и при следующем
    // рендере сетка уже видит её на новом месте. onSuccess ниже всё
    // равно делает invalidateQueries — там прилетит свежий ответ и
    // перезапишет кэш, но пользователь этого уже не заметит.
    onMutate: async ({ id, ...patch }) => {
      await qc.cancelQueries({ queryKey: ["tasks"] });
      const prev = qc.getQueryData<ApiTask[]>(["tasks"]);
      if (prev) {
        qc.setQueryData<ApiTask[]>(
          ["tasks"],
          prev.map((t) =>
            t.id === id ? ({ ...t, ...patch } as ApiTask) : t,
          ),
        );
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      // Откат при ошибке сети/сервера — иначе плашка зависнет на
      // оптимистичной позиции и будет расходиться с реальностью.
      if (ctx?.prev) qc.setQueryData(["tasks"], ctx.prev);
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      if (data?.task) {
        AppleIntegrations.syncTaskToApple(data.task);
      }
    },
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => {
      AppleIntegrations.deleteTaskFromApple(id);
      return api.delete<{ ok: boolean }>(`/api/tasks/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

// ═══════════ Agent-work protocol (AGENT-PROTOCOL.md) ═══════════
// Three thin wrappers around server/src/routes/agent-state.ts, same
// mutation/invalidation shape as the CRUD hooks above: `useUpdateTask`
// invalidates the whole ["tasks"] prefix (covers both the list and this
// task's ["tasks", id] detail query) rather than seeding the cache from
// the response, and these three follow the same convention — claim/state
// return a full hydrated task (labels/subtasks included) but heartbeat
// doesn't, so seeding from the response isn't an option there anyway.

// POST /api/tasks/:id/claim — take the task into work. Used by an agent
// caller (or a human testing the protocol); the owner-facing UI in
// TaskJournal.tsx never calls this itself.
export function useClaimTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ task: ApiTask }>(`/api/tasks/${id}/claim`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

// POST /api/tasks/:id/heartbeat — renew the 15-minute lease. Deliberately
// does not touch updated_at/task_events server-side (see agent-state.ts),
// so this hook still invalidates ["tasks"] itself to pull the fresh
// agent_heartbeat_at into the cache.
export function useTaskHeartbeat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ lease_expires_at: string }>(`/api/tasks/${id}/heartbeat`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

// POST /api/tasks/:id/state — explicit transition. `comment` is mandatory
// server-side for `state: "blocked" | "review"` (400 without it); for the
// owner actions this app exposes ("Вернуть на доработку" → in_progress,
// "Снять с агента" → null) it's optional/omittable, but always pass
// whatever the caller collected so the explanation lands in the same
// comment feed as everything else.
export function useSetAgentState() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      state,
      comment,
    }: {
      id: string;
      state: AgentState | null;
      comment?: string;
    }) =>
      api.post<{ task: ApiTask }>(`/api/tasks/${id}/state`, { state, comment }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

// POST /api/tasks/:id/repeat-extend — владелец продлевает завершённую серию
// повтора на следующий календарный год: сервер ставит repeat_until =
// «31 декабря следующего года» и сбрасывает recurrence_spawned, после чего
// воркер снова может создавать вхождения. Доступно только владельцу (403).
export function useExtendRepeat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ ok: boolean; repeat_until: string }>(
        `/api/tasks/${id}/repeat-extend`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

// POST /api/tasks/:id/run — ручной разовый запуск агента на карточке по
// команде владельца: executor — поднять исполнителя, reviewer — верификатора.
// Служба-будильник при этом может быть выключена: это одиночный заход, а не
// автоматика. Ничего в авторежиме не включает.
export function useRunTaskAgent() {
  return useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: "executor" | "reviewer" }) =>
      api.post<{ ok: boolean; mode: string }>(`/api/tasks/${id}/run`, { mode }),
  });
}

// POST /api/tasks/:id/research — ручной запуск серверного конвейера глубокого
// исследования (владелец, задача помечена needs_research). Сервер поднимает
// отдельный процесс и сразу отвечает: план → сбор → проверка → синтез →
// отчёт в секции «Отчёты» карточки.
export function useStartResearch() {
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ ok: boolean; started: boolean }>(
        `/api/tasks/${id}/research`,
        {},
      ),
  });
}
