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
