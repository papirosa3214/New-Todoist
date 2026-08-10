import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";

const uid = () => crypto.randomUUID();

// ═══════ TASKS CRUD ═══════

export function registerTaskRoutes(app: FastifyInstance) {
  const authPre = async (req: any, reply: any) => {
    try {
      const token = req.headers.authorization?.replace("Bearer ", "");
      if (!token) return reply.code(401).send({ error: "No token" });
      req.userId = app.jwt.verify(token).id;
    } catch { reply.code(401).send({ error: "Invalid token" }); }
  };

  // List tasks
  app.get("/api/tasks", { preHandler: authPre }, async (req: any) => {
    const userId = req.userId;
    const tasks = db.prepare(`
      SELECT t.*, u.name as assignee_name, u.avatar_color as assignee_color, u.initials as assignee_initials,
             p.name as project_name, p.color as project_color
      FROM tasks t
      LEFT JOIN users u ON t.assignee_id = u.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.creator_id = ? OR t.assignee_id = ?
      ORDER BY t.created_at DESC
    `).all(userId, userId) as any[];

    // Attach labels
    const stmtLabels = db.prepare(`
      SELECT l.id, l.name, l.color FROM labels l
      JOIN task_labels tl ON tl.label_id = l.id WHERE tl.task_id = ?
    `);
    // Attach subtasks
    const stmtSub = db.prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY position");

    return tasks.map((t: any) => ({
      ...t,
      labels: stmtLabels.all(t.id),
      subtasks: stmtSub.all(t.id).map((s: any) => ({ ...s, done: !!s.done })),
    }));
  });

  // Get single task
  app.get<{ Params: { id: string } }>("/api/tasks/:id", { preHandler: authPre }, async (req) => {
    const task = db.prepare(`
      SELECT t.*, u.name as assignee_name, u.avatar_color as assignee_color, u.initials as assignee_initials
      FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id WHERE t.id = ?
    `).get(req.params.id) as any;
    if (!task) return { error: "Not found" };

    const labels = db.prepare(`
      SELECT l.* FROM labels l JOIN task_labels tl ON tl.label_id = l.id WHERE tl.task_id = ?
    `).all(task.id);
    const subtasks = db.prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY position").all(task.id)
      .map((s: any) => ({ ...s, done: !!s.done }));
    const comments = db.prepare(`
      SELECT c.*, u.name as user_name, u.avatar_color as user_color, u.initials as user_initials
      FROM comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.task_id = ? ORDER BY c.created_at
    `).all(task.id);

    return { ...task, labels, subtasks, comments };
  });

  // Create task
  app.post<{
    Body: {
      title: string; description?: string; due_date?: string;
      project_id?: string; priority?: number; assignee_id?: string;
      label_ids?: string[];
    };
  }>("/api/tasks", {
    preHandler: async (req: any, reply) => {
      try {
        const token = req.headers.authorization?.replace("Bearer ", "");
        if (!token) return reply.code(401).send({ error: "No token" });
        req.userId = app.jwt.verify(token).id;
      } catch { reply.code(401).send({ error: "Invalid token" }); }
    },
    handler: async (req: any, reply) => {
      const { title, description, due_date, project_id, priority, assignee_id, label_ids } = req.body;
      if (!title) return reply.code(400).send({ error: "title required" });

      const id = uid();
      db.prepare(`
        INSERT INTO tasks (id, title, description, due_date, project_id, priority, assignee_id, creator_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, title, description || null, due_date || null, project_id || null, priority || 1, assignee_id || null, req.userId);

      if (label_ids?.length) {
        const ins = db.prepare("INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)");
        for (const lid of label_ids) ins.run(id, lid);
      }

      // Create notification for assignee
      if (assignee_id && assignee_id !== req.userId) {
        db.prepare(
          "INSERT INTO notifications (id, user_id, type, task_id, text) VALUES (?, ?, 'assigned', ?, ?)",
        ).run(uid(), assignee_id, id, `Новая задача назначена: ${title}`);
      }

      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      return { task };
    },
  });

  // Update task
  app.patch<{ Params: { id: string }; Body: Partial<{
    title: string; description: string; due_date: string;
    project_id: string; priority: number; assignee_id: string;
    status: string; label_ids: string[];
  }> }>("/api/tasks/:id", {
    preHandler: async (req: any, reply) => {
      try {
        const token = req.headers.authorization?.replace("Bearer ", "");
        if (!token) return reply.code(401).send({ error: "No token" });
        req.userId = app.jwt.verify(token).id;
      } catch { reply.code(401).send({ error: "Invalid token" }); }
    },
    handler: async (req, reply) => {
      const { id } = req.params;
      const body = req.body;
      const fields: string[] = [];
      const values: any[] = [];

      for (const [k, v] of Object.entries(body)) {
        if (k === "label_ids") continue;
        if (v !== undefined) {
          fields.push(`${k} = ?`);
          values.push(v);
        }
      }
      if (fields.length) {
        fields.push("updated_at = datetime('now')");
        values.push(id);
        db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      }

      // Update labels
      if (body.label_ids) {
        db.prepare("DELETE FROM task_labels WHERE task_id = ?").run(id);
        const ins = db.prepare("INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)");
        for (const lid of body.label_ids) ins.run(id, lid);
      }

      // Notification for assignee change
      if (body.assignee_id && body.assignee_id !== (req as any).userId) {
        const task = db.prepare("SELECT title FROM tasks WHERE id = ?").get(id) as any;
        db.prepare(
          "INSERT INTO notifications (id, user_id, type, task_id, text) VALUES (?, ?, 'assigned', ?, ?)",
        ).run(uid(), body.assignee_id, id, `Вас назначили на: ${task?.title || id}`);
      }

      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      return { task };
    },
  });

  // Delete task
  app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (req) => {
    db.prepare("DELETE FROM task_labels WHERE task_id = ?").run(req.params.id);
    db.prepare("DELETE FROM subtasks WHERE task_id = ?").run(req.params.id);
    db.prepare("DELETE FROM comments WHERE task_id = ?").run(req.params.id);
    db.prepare("DELETE FROM notifications WHERE task_id = ?").run(req.params.id);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);
    return { ok: true };
  });
}
