import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";

const uid = () => crypto.randomUUID();

export function registerSubtaskCommentRoutes(app: FastifyInstance) {
  const authPre = async (req: any, reply: any) => {
    try {
      const token = req.headers.authorization?.replace("Bearer ", "");
      if (!token) return reply.code(401).send({ error: "No token" });
      req.userId = app.jwt.verify(token).id;
    } catch { reply.code(401).send({ error: "Invalid token" }); }
  };

  // ── Subtasks ──
  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/subtasks", async (req) => {
    return db.prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY position").all(req.params.taskId);
  });

  app.post<{ Params: { taskId: string }; Body: { title: string } }>("/api/tasks/:taskId/subtasks", {
    preHandler: authPre,
    handler: async (req: any) => {
      const id = uid();
      const maxPos = db.prepare("SELECT COALESCE(MAX(position),0) as m FROM subtasks WHERE task_id = ?").get(req.params.taskId) as any;
      db.prepare("INSERT INTO subtasks (id, task_id, title, position) VALUES (?,?,?,?)").run(id, req.params.taskId, req.body.title, maxPos.m + 1);
      return db.prepare("SELECT * FROM subtasks WHERE id = ?").get(id);
    },
  });

  app.patch<{ Params: { id: string }; Body: { done?: boolean; title?: string } }>("/api/subtasks/:id", {
    preHandler: authPre,
    handler: async (req) => {
      const { done, title } = req.body;
      if (done !== undefined) db.prepare("UPDATE subtasks SET done = ? WHERE id = ?").run(done ? 1 : 0, req.params.id);
      if (title) db.prepare("UPDATE subtasks SET title = ? WHERE id = ?").run(title, req.params.id);
      return db.prepare("SELECT * FROM subtasks WHERE id = ?").get(req.params.id);
    },
  });

  app.delete<{ Params: { id: string } }>("/api/subtasks/:id", { preHandler: authPre }, async (req) => {
    db.prepare("DELETE FROM subtasks WHERE id = ?").run(req.params.id);
    return { ok: true };
  });

  // ── Comments ──
  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/comments", async (req) => {
    return db.prepare(`
      SELECT c.*, u.name as user_name, u.avatar_color as user_color, u.initials as user_initials
      FROM comments c LEFT JOIN users u ON c.user_id = u.id
      WHERE c.task_id = ? ORDER BY c.created_at
    `).all(req.params.taskId);
  });

  app.post<{ Params: { taskId: string }; Body: { text: string } }>("/api/tasks/:taskId/comments", {
    preHandler: authPre,
    handler: async (req: any) => {
      const id = uid();
      db.prepare("INSERT INTO comments (id, task_id, user_id, text) VALUES (?,?,?,?)").run(id, req.params.taskId, req.userId, req.body.text);

      // Notify task assignee
      const task = db.prepare("SELECT assignee_id, title FROM tasks WHERE id = ?").get(req.params.taskId) as any;
      if (task?.assignee_id && task.assignee_id !== req.userId) {
        const user = db.prepare("SELECT name FROM users WHERE id = ?").get(req.userId) as any;
        db.prepare(
          "INSERT INTO notifications (id, user_id, type, task_id, text) VALUES (?, ?, 'commented', ?, ?)",
        ).run(uid(), task.assignee_id, req.params.taskId, `${user?.name || 'Кто-то'} прокомментировал: ${task.title}`);
      }

      return db.prepare(`
        SELECT c.*, u.name as user_name, u.avatar_color as user_color, u.initials as user_initials
        FROM comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.id = ?
      `).get(id);
    },
  });
}
