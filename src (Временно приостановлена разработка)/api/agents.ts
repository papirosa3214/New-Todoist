import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { ApiUser } from "./types";

// GET /api/agents returns every user in the system (not scoped to the
// caller's team — the server has no team/workspace concept yet).
export function useAgents() {
  return useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get<ApiUser[]>("/api/agents"),
    // Статус «онлайн/офлайн» теперь живой (server/src/ws.ts: пишется по
    // открытию и закрытию сокета), а этот запрос выполнялся ровно один раз
    // за сессию — экран агентов показывал бы состояние на момент захода и
    // больше никогда не менялся. Раз в 15 секунд и при возврате в приложение
    // достаточно: это индикатор присутствия, а не секундомер.
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });
}

// Завести агента (экран агентов, кнопка «Завести агента»). Ключ доступа
// приходит в ответе ровно один раз — сервер его больше не показывает нигде,
// поэтому вызывающий обязан показать его пользователю сразу.
export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<{ agent: ApiUser; api_token: string }>("/api/agents", { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

// Переименовать агента (карандаш на строке в «Команде»). Только владелец —
// сервер и так это проверит (403), но кнопку владелец видит только у себя,
// см. AgentsScreen.tsx.
export function useRenameAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch<{ agent: ApiUser }>(`/api/agents/${id}`, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

// Удалить агента (корзина на той же строке). Сервер отказывает 403 на
// системных ботов (Claude_Bot/Hermes/DeepSeek-Agent — зашиты в конвейер) и
// 409, если за агентом остались задачи/комментарии — тогда сначала их
// нужно переназначить или удалить самому.
export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/api/agents/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

/** Состояние службы-будильника: включён ли автономный режим. */
export interface AgentServiceState {
  /** Служба работает прямо сейчас. */
  active: boolean;
  /** Поднимется сама после перезагрузки машины. */
  enabled: boolean;
  /** Когда будильник в последний раз отметился живым (ISO), null — не отмечался. */
  last_alive_at: string | null;
  /** Ближайший обход доски (ISO); null, когда служба выключена. */
  next_scan_at: string | null;
  /** Период обхода доски в секундах — чтобы экран не зашивал своё число. */
  scan_interval_sec: number;
  /** Планировщик расписания (taskflow-scheduler) — независимая лампа:
   *  живёт вне будильника, делает запуск по времени и отложенные повторы. */
  scheduler?: {
    active: boolean;
    last_run_at: string | null;
    handled?: Record<string, number>;
  };
}

// Автономный режим = служба-будильник. Включена — назначенную задачу
// подхватит двойник; выключена — задачи ведёт живая сессия.
//
// Опрашиваем в том же ритме, что и агентов: состояние может измениться и
// снаружи (например, из терминала), плашка обязана это показывать.
export function useAgentService() {
  return useQuery({
    queryKey: ["agent-service"],
    queryFn: () => api.get<AgentServiceState>("/api/agent-service"),
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });
}

export function useToggleAgentService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) =>
      api.post<AgentServiceState>("/api/agent-service", { on }),
    // Обновляем и агентов: включённая служба открывает соединение под
    // учёткой агента, и «онлайн» в списке меняется следом за тумблером.
    onSuccess: (state) => {
      qc.setQueryData(["agent-service"], state);
      qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

export interface TaskIntakeSettings {
  mode: "manual" | "automatic";
  reviewer_first_default: boolean;
}

// GET /api/task-intake/settings — режим «автоодобрения задачи» (идёт ли
// карточка дальше сама) и общий маршрут ревью («Авторевьюер»).
export function useTaskIntakeSettings() {
  return useQuery({
    queryKey: ["task-intake-settings"],
    queryFn: () => api.get<TaskIntakeSettings>("/api/task-intake/settings"),
  });
}

// PATCH /api/task-intake/settings — переключить «Автоодобрение задачи»:
// automatic — карточка уходит дальше без флага владельца, manual — ждёт его.
export function useSetTaskIntakeMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: TaskIntakeSettings["mode"]) =>
      api.patch<TaskIntakeSettings>("/api/task-intake/settings", { mode }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["task-intake-settings"] }),
  });
}

// PATCH /api/task-intake/settings — переключить «Авторевьюер» (общий
// маршрут новых карточек; раньше был флагом на каждой карточке).
export function useSetReviewerFirstDefault() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) =>
      api.patch<TaskIntakeSettings>("/api/task-intake/settings", {
        reviewer_first_default: on,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["task-intake-settings"] }),
  });
}
