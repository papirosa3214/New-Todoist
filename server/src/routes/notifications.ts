import type { FastifyInstance } from "fastify";
import db from "../db.js";

export function registerNotificationRoutes(app: FastifyInstance) {
  const authPre = async (req: any, reply: any) => {
    try {
      const token = req.headers.authorization?.replace("Bearer ", "");
      if (!token) return reply.code(401).send({ error: "No token" });
      req.userId = app.jwt.verify(token).id;
    } catch { reply.code(401).send({ error: "Invalid token" }); }
  };

  app.get("/api/notifications", { preHandler: authPre }, async (req: any) => {
    return db.prepare(`
      SELECT n.*, u.name as user_name, u.avatar_color as user_color, u.initials as user_initials,
             t.title as task_title
      FROM notifications n
      LEFT JOIN users u ON n.user_id = u.id
      LEFT JOIN tasks t ON n.task_id = t.id
      WHERE n.user_id = ?
      ORDER BY n.created_at DESC
    `).all(req.userId);
  });

  app.post("/api/notifications/read-all", { preHandler: authPre }, async (req: any) => {
    db.prepare("UPDATE notifications SET read = 1 WHERE user_id = ?").run(req.userId);
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>("/api/notifications/:id/read", { preHandler: authPre }, async (req) => {
    db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(req.params.id);
    return { ok: true };
  });
}
