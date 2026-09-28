import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { isServiceUser } from "./agent-state.js";

const uid = () => crypto.randomUUID();

export function registerNotificationRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // POST /api/notifications — служебная дверь для планировщика (шаг 5).
  // Только service user. Создаёт уведомление для указанного user_id
  // (как правило, владельца) с типом task_dead и текстом причины.
  app.post<{
    Body: {
      user_id: string;
      type: string;
      task_id?: string;
      text: string;
      actor_id?: string;
    };
  }>("/api/notifications", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      if (!isServiceUser(req.userId)) {
        return reply.code(403).send({
          error:
            "создавать уведомления через API может только служебный ключ",
        });
      }
      const { user_id, type, task_id, text, actor_id } = req.body || {};
      if (typeof user_id !== "string" || !user_id) {
        return reply.code(400).send({ error: "user_id обязателен" });
      }
      if (typeof type !== "string" || !type) {
        return reply.code(400).send({ error: "type обязателен" });
      }
      if (typeof text !== "string" || !text.trim()) {
        return reply.code(400).send({ error: "text обязателен" });
      }
      const id = uid();
      db.prepare(
        `INSERT INTO notifications (id, user_id, type, task_id, text, actor_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        user_id,
        type,
        task_id ?? null,
        text.trim(),
        actor_id ?? null,
      );
      const inserted = db.prepare("SELECT id FROM notifications WHERE id=?").get(id);
      return inserted ? reply.code(201).send({ id }) : reply.code(200).send({ suppressed: true });
    },
  });

  app.get("/api/notifications", { preHandler: authPre }, async (req: any) => {
    return db
      .prepare(
        `
      SELECT n.*, u.name as user_name, u.avatar_color as user_color, u.initials as user_initials,
             t.title as task_title,
             a.id as actor_id, a.name as actor_name, a.initials as actor_initials, a.avatar_color as actor_color, a.avatar_url as actor_avatar_url
      FROM notifications n
      LEFT JOIN users u ON n.user_id = u.id
      LEFT JOIN tasks t ON n.task_id = t.id
      LEFT JOIN users a ON n.actor_id = a.id
      WHERE n.user_id = ? AND NOT (n.type IN ('assigned','commented','reviewed','agent_state') AND EXISTS (SELECT 1 FROM users owner WHERE owner.id=n.user_id AND owner.role='owner'))
      ORDER BY n.created_at DESC
    `,
      )
      .all(req.userId);
  });

  app.post(
    "/api/notifications/read-all",
    { preHandler: authPre },
    async (req: any) => {
      db.prepare("UPDATE notifications SET read = 1 WHERE user_id = ?").run(
        req.userId,
      );
      return { ok: true };
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/notifications/:id/read",
    { preHandler: authPre },
    async (req: any, reply) => {
      const result = db
        .prepare(
          "UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?",
        )
        .run(req.params.id, req.userId);
      if (result.changes === 0)
        return reply.code(404).send({ error: "Not found" });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/notifications/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const result = db
        .prepare("DELETE FROM notifications WHERE id = ? AND user_id = ?")
        .run(req.params.id, req.userId);
      if (result.changes === 0)
        return reply.code(404).send({ error: "Not found" });
      return { ok: true };
    },
  );
}
