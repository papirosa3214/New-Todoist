import { useQuery } from "@tanstack/react-query";
import { api, getToken } from "./client";

/** Состояние сервера — для раздела «Сервер» в настройках.
 *
 * Владелец 21.08.2026: «выведи в настройках информацию о статусе сервера».
 * Повод: сервер поднимается вручную и после перезапуска сам не встал —
 * из приложения это выглядело как «ничего не грузится», а понять причину
 * можно было только из терминала, которого у владельца под рукой нет.
 */
export interface ServerStatus {
  ok: boolean;
  started_at: string;
  uptime_sec: number;
  node: string;
  commit: string | null;
  commit_at: string | null;
  tasks_active: number;
  tasks_total: number;
  db_bytes: number | null;
  /** active | inactive | failed | unknown — служба будильника. */
  trigger: string | null;
  ollama_online?: boolean;
  ollama_model?: string;
  server_ip?: string;
}

export function useServerStatus() {
  return useQuery({
    queryKey: ["server-status"],
    queryFn: () => api.get<ServerStatus>("/api/server-status"),
    enabled: !!getToken(),
    retry: false,
    // Минуту держим ответ: аптайм на экране настроек не тикает, а запрос
    // дёргает git и systemctl — незачем повторять его на каждом входе.
    staleTime: 60 * 1000,
  });
}
