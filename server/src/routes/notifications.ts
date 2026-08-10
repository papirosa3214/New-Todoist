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
             t.title as task_title
      FROM notifications n
      LEFT JOIN users u ON n.user_id = u.id
      LEFT JOIN tasks t ON n.task_id = t.id
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
}
