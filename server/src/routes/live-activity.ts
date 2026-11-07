// Приём токенов Live Activity (Dynamic Island) с устройства.
//
// Зачем это вообще: активность на iPhone запускает приложение, но двигать её,
// пока приложение свёрнуто, может только APNs — JS в фоне не выполняется.
// Система выдаёт приложению токен на каждую запущенную активность, приложение
// присылает его сюда, а apns.ts по нему досылает прогресс.
//
// Токен не секрет пользователя и не даёт доступа к аккаунту: с ним можно лишь
// обновить конкретную карточку на конкретном устройстве. Тем не менее роут
// закрыт обычной авторизацией — чужие задачи в чужой островок не подсунуть.

import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";

export function registerLiveActivityRoutes(app: FastifyInstance) {
  app.post<{ Body: { taskId?: string; token?: string } }>(
    "/api/live-activity/token",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      const { taskId, token } = req.body || {};
      if (!taskId || !token) {
        return reply.code(400).send({ error: "taskId и token обязательны" });
      }

      // Задача должна существовать и быть видна этому пользователю — иначе
      // строка в таблице повиснет мусором на несуществующий id.
      const task = db
        .prepare("SELECT id, creator_id, assignee_id FROM tasks WHERE id = ?")
        .get(taskId) as any;
      if (!task) return reply.code(404).send({ error: "Задача не найдена" });

      // Токен перезаписывается: у задачи один живой островок, а система
      // время от времени выдаёт новый токен взамен старого.
      // started_at ставится только при первом появлении карточки: система
      // выдаёт новый токен и посреди работы, а точка отсчёта таймера при этом
      // сдвигаться не должна.
      db.prepare(
        `INSERT INTO live_activity_tokens (task_id, user_id, token, updated_at, started_at)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(task_id) DO UPDATE SET
           user_id = excluded.user_id,
           token = excluded.token,
           updated_at = excluded.updated_at`,
      ).run(taskId, req.userId, token);

      return { ok: true };
    },
  );

  // Приложение погасило островок само (задача закрыта, человек смахнул
  // карточку) — снимаем токен, чтобы сервер не стучался в мёртвую активность.
  app.delete<{ Params: { taskId: string } }>(
    "/api/live-activity/token/:taskId",
    { preHandler: authOrApiToken },
    async (req: any) => {
      db.prepare("DELETE FROM live_activity_tokens WHERE task_id = ?").run(
        req.params.taskId,
      );
      return { ok: true };
    },
  );
}
