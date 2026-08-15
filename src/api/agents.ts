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

/** Состояние службы-будильника: включён ли автономный режим. */
export interface AgentServiceState {
  /** Служба работает прямо сейчас. */
  active: boolean;
  /** Поднимется сама после перезагрузки машины. */
  enabled: boolean;
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
