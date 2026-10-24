import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

// Восемь канонических ролей с собранным профилем (GET /api/roles).
//
// Это НЕ то же, что /api/agents: там учётки-личности, здесь — компетенции
// и их живая конфигурация, собранная сервером из промптов, профилей Pi,
// маршрутизации и базы. Экран показывает ровно то, с чем стартует
// исполнитель: отдельной копии настроек на клиенте нет и быть не должно —
// иначе карточка роли покажет одно, а запустится другое.

export type RoleStatus = "ready" | "working" | "blocked" | "unavailable";

export type RoleSkill = {
  skill_name: string;
  description: string | null;
};

export type RoleAttemptPolicy = {
  reason_code: string;
  from_model: string;
  to_model: string | null;
  max_attempts: number;
  cooldown_seconds: number;
};

export type RoleDetails = {
  role: string;
  /** Имя роли из её учётки — переименование подхватывается само. */
  title: string;
  account_id: string | null;
  status: RoleStatus;
  /** Подпись статуса по-русски, готовая к показу. */
  status_title: string;
  /** Жив ли исполнитель, которым работают все роли. Общая причина
   *  недоступности — показывается один раз на список, а не в каждой
   *  строке. */
  runtime_ready: boolean;
  /** Почему роль недоступна. Пусто — проблем нет. */
  problems: string[];
  prompt: string;
  skills: RoleSkill[];
  tools: string[];
  permissions: string | null;
  model?: string;
  default_shell?: string;
  fallbacks?: string[];
  attempt_policy: RoleAttemptPolicy[];
  current_task: { id: string; title: string; state: string | null } | null;
  last_activity: string | null;
};

export function useRoles() {
  return useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get<{ roles: RoleDetails[] }>("/api/roles"),
    select: (data) => data.roles,
    // Статус роли живой: она берёт карточку, упирается, освобождается.
    // Тот же интервал, что у списка агентов рядом, — это индикатор
    // присутствия, а не секундомер.
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });
}
