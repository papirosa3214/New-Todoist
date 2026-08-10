import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { broadcastToUsers } from "../ws.js";
import {
  getTaskForUser,
  getTaskForOwnerDelete,
  allLabelsOwnedByUser,
} from "../access.js";

const uid = () => crypto.randomUUID();

const ALLOWED_STATUS = ["active", "completed"];

function hydrateTask(task: any) {
  const labels = db
    .prepare(
      `SELECT l.id, l.name, l.color FROM labels l
       JOIN task_labels tl ON tl.label_id = l.id WHERE tl.task_id = ?`,
    )
    .all(task.id);
  const subtasks = db
    .prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY position")
    .all(task.id)
    .map((s: any) => ({ ...s, done: !!s.done }));
  return { ...task, labels, subtasks };
}

// ═══════ TASKS CRUD ═══════

export function registerTaskRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // List tasks — only ones the caller created or is assigned to.
  app.get("/api/tasks", { preHandler: authPre }, async (req: any) => {
    const userId = req.userId;
    const tasks = db
      .prepare(
        `
      SELECT t.*, u.name as assignee_name, u.avatar_color as assignee_color, u.initials as assignee_initials,
             p.name as project_name, p.color as project_color
      FROM tasks t
      LEFT JOIN users u ON t.assignee_id = u.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.creator_id = ? OR t.assignee_id = ?
      ORDER BY t.created_at DESC
    `,
      )
      .all(userId, userId) as any[];

    const stmtLabels = db.prepare(`
      SELECT l.id, l.name, l.color FROM labels l
      JOIN task_labels tl ON tl.label_id = l.id WHERE tl.task_id = ?
    `);
    const stmtSub = db.prepare(
      "SELECT * FROM subtasks WHERE task_id = ? ORDER BY position",
    );

    return tasks.map((t: any) => ({
      ...t,
      labels: stmtLabels.all(t.id),
      subtasks: stmtSub.all(t.id).map((s: any) => ({ ...s, done: !!s.done })),
    }));
  });

  // Get single task — must be creator or assignee.
  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const task = getTaskForUser(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

      const full = db
        .prepare(
          `SELECT t.*, u.name as assignee_name, u.avatar_color as assignee_color, u.initials as assignee_initials
           FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id WHERE t.id = ?`,
        )
        .get(task.id) as any;

      const labels = db
        .prepare(
          `SELECT l.* FROM labels l JOIN task_labels tl ON tl.label_id = l.id WHERE tl.task_id = ?`,
        )
        .all(task.id);
      const subtasks = db
        .prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY position")
        .all(task.id)
        .map((s: any) => ({ ...s, done: !!s.done }));
      const comments = db
        .prepare(
          `SELECT c.*, u.name as user_name, u.avatar_color as user_color, u.initials as user_initials
           FROM comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.task_id = ? ORDER BY c.created_at`,
        )
        .all(task.id);

      return { ...full, labels, subtasks, comments };
    },
  );

  // Create task
  app.post<{
    Body: {
      title: string;
      description?: string;
      due_date?: string;
      project_id?: string;
      priority?: number;
      assignee_id?: string;
      label_ids?: string[];
    };
  }>("/api/tasks", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const {
        title,
        description,
        due_date,
        project_id,
        priority,
        assignee_id,
        label_ids,
      } = req.body;
      if (!title) return reply.code(400).send({ error: "title required" });

      if (priority !== undefined && !(priority >= 1 && priority <= 4)) {
        return reply
          .code(400)
          .send({ error: "priority must be between 1 and 4" });
      }

      // project_id must belong to the caller — no filing tasks into someone else's project.
      if (project_id) {
        const project = db
          .prepare("SELECT id FROM projects WHERE id = ? AND owner_id = ?")
          .get(project_id, req.userId);
        if (!project)
          return reply.code(400).send({ error: "invalid project_id" });
      }

      // label_ids must all belong to the caller.
      if (label_ids?.length && !allLabelsOwnedByUser(label_ids, req.userId)) {
        return reply.code(400).send({ error: "invalid label_ids" });
      }

      // assignee_id must reference an existing user.
      if (assignee_id) {
        const assignee = db
          .prepare("SELECT id FROM users WHERE id = ?")
          .get(assignee_id);
        if (!assignee)
          return reply.code(400).send({ error: "invalid assignee_id" });
      }

      const id = uid();
      db.prepare(
        `
        INSERT INTO tasks (id, title, description, due_date, project_id, priority, assignee_id, creator_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        id,
        title,
        description || null,
        due_date || null,
        project_id || null,
        priority || 1,
        assignee_id || null,
        req.userId,
      );

      if (label_ids?.length) {
        const ins = db.prepare(
          "INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)",
        );
        for (const lid of label_ids) ins.run(id, lid);
      }

      // Create notification for assignee
      if (assignee_id && assignee_id !== req.userId) {
        const notifId = uid();
        db.prepare(
          "INSERT INTO notifications (id, user_id, type, task_id, text) VALUES (?, ?, 'assigned', ?, ?)",
        ).run(notifId, assignee_id, id, `Новая задача назначена: ${title}`);
        broadcastToUsers([assignee_id], {
          type: "notification:new",
          notificationId: notifId,
          taskId: id,
        });
      }

      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      broadcastToUsers([req.userId, assignee_id], {
        type: "task:created",
        task: hydrateTask(task),
      });
      return { task };
    },
  });

  // Update task — caller must be creator or assignee. Only a fixed set of
  // columns is writable (no mass-assignment of id/creator_id/created_at/etc).
  app.patch<{
    Params: { id: string };
    Body: Partial<{
      title: string;
      description: string;
      due_date: string;
      project_id: string;
      priority: number;
      assignee_id: string;
      status: string;
      label_ids: string[];
    }>;
  }>("/api/tasks/:id", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const { id } = req.params;
      const body = req.body || {};

      const existing = getTaskForUser(id, req.userId);
      if (!existing) return reply.code(404).send({ error: "Not found" });

      if (body.status !== undefined && !ALLOWED_STATUS.includes(body.status)) {
        return reply.code(400).send({ error: "invalid status" });
      }
      if (
        body.priority !== undefined &&
        !(body.priority >= 1 && body.priority <= 4)
      ) {
        return reply
          .code(400)
          .send({ error: "priority must be between 1 and 4" });
      }
      if (body.project_id) {
        const project = db
          .prepare("SELECT id FROM projects WHERE id = ? AND owner_id = ?")
          .get(body.project_id, req.userId);
        if (!project)
          return reply.code(400).send({ error: "invalid project_id" });
      }
      if (body.assignee_id) {
        const assignee = db
          .prepare("SELECT id FROM users WHERE id = ?")
          .get(body.assignee_id);
        if (!assignee)
          return reply.code(400).send({ error: "invalid assignee_id" });
      }
      if (
        body.label_ids?.length &&
        !allLabelsOwnedByUser(body.label_ids, req.userId)
      ) {
        return reply.code(400).send({ error: "invalid label_ids" });
      }

      // Whitelisted columns only — request body keys never reach raw SQL.
      const ALLOWED_FIELDS = [
        "title",
        "description",
        "due_date",
        "project_id",
        "priority",
        "assignee_id",
        "status",
      ] as const;
      const fields: string[] = [];
      const values: any[] = [];
      for (const key of ALLOWED_FIELDS) {
        if (body[key] !== undefined) {
          fields.push(`${key} = ?`);
          values.push(body[key]);
        }
      }
      if (fields.length) {
        fields.push("updated_at = datetime('now')");
        values.push(id);
        db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(
          ...values,
        );
      }

      // Update labels
      if (body.label_ids) {
        db.prepare("DELETE FROM task_labels WHERE task_id = ?").run(id);
        const ins = db.prepare(
          "INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)",
        );
        for (const lid of body.label_ids) ins.run(id, lid);
      }

      // Notification for assignee change
      if (body.assignee_id && body.assignee_id !== req.userId) {
        const notifId = uid();
        db.prepare(
          "INSERT INTO notifications (id, user_id, type, task_id, text) VALUES (?, ?, 'assigned', ?, ?)",
        ).run(
          notifId,
          body.assignee_id,
          id,
          `Вас назначили на: ${existing.title || id}`,
        );
        broadcastToUsers([body.assignee_id], {
          type: "notification:new",
          notificationId: notifId,
          taskId: id,
        });
      }

      const task = db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(id) as any;
      const eventType =
        body.status === "completed" ? "task:completed" : "task:updated";
      // Notify old + new assignee, and the creator, so nobody's client goes stale.
      broadcastToUsers(
        [existing.creator_id, existing.assignee_id, task.assignee_id],
        {
          type: eventType,
          task: hydrateTask(task),
        },
      );

      return { task };
    },
  });

  // Delete task — creator only (assignees complete tasks, they don't delete them).
  app.delete<{ Params: { id: string } }>(
    "/api/tasks/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const task = getTaskForOwnerDelete(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

      db.prepare("DELETE FROM task_labels WHERE task_id = ?").run(
        req.params.id,
      );
      db.prepare("DELETE FROM subtasks WHERE task_id = ?").run(req.params.id);
      db.prepare("DELETE FROM comments WHERE task_id = ?").run(req.params.id);
      db.prepare("DELETE FROM notifications WHERE task_id = ?").run(
        req.params.id,
      );
      db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);

      broadcastToUsers([task.creator_id, task.assignee_id], {
        type: "task:deleted",
        id: req.params.id,
      });
      return { ok: true };
    },
  );
}
