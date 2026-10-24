// Данные для экрана «Загрузка ролей» (Гант по факту, карточка
// 1117d06c…). Контракт эндпоинта — GET /api/coordination/role-load
// (см. server/src/routes/coordination.ts). Окна: 24h / 3d / week.
//
// Нам важны три слоя:
//   attempts  — фактические заходы агентов, рисуются полосами по шкале;
//   active_now — что прямо сейчас в работе (выделить отдельным стилем);
//   open_slots — задачи в работе без исполнителя (тоже отдельным стилем,
//                чтобы не терялись с глаз — это и есть второй слой
//                из постановки).

import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

export type RoleLoadWindow = "24h" | "3d" | "week";

export type RoleLoadRole = {
  key: string;
  title: string;
  position: number;
  executor_id: string | null;
};

export type RoleLoadAttempt = {
  id: string;
  task_id: string;
  task_title: string;
  subtask_id: string | null;
  executor_id: string;
  routing_role: string | null;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  active: boolean;
};

export type RoleLoadActive = {
  kind: "subtask" | "task";
  id: string;
  task_id: string;
  task_title: string;
  role_key: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
};

export type RoleLoadOpenSlot = {
  kind: "task";
  id: string;
  task_title: string;
  role_key: string | null;
  state: string;
  since: string | null;
};

export type RoleLoadData = {
  window: RoleLoadWindow;
  from: string;
  to: string;
  now: string;
  roles: RoleLoadRole[];
  attempts: RoleLoadAttempt[];
  active_now: RoleLoadActive[];
  open_slots: RoleLoadOpenSlot[];
};

export function useRoleLoad(window: RoleLoadWindow) {
  return useQuery({
    // Кэш — по окну: переключение 24h/3d/week меняет данные, и в кэше
    // должны быть все три, чтобы возврат не дёргал сеть.
    queryKey: ["role-load", window],
    queryFn: () =>
      api.get<RoleLoadData>(`/api/coordination/role-load?window=${window}`),
    // Гант живёт состоянием ролей: попытка стартует и заканчивается.
    // Тот же интервал, что у сводки в AgentsScreen — это индикатор, а
    // не секундомер.
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}