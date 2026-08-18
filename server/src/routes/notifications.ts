import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";

export function registerNotificationRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

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
      WHERE n.user_id = ?
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
