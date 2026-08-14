import { useQuery } from "@tanstack/react-query";
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
