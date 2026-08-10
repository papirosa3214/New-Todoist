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

// due_date is stored as plain "YYYY-MM-DD" text (see db.ts, and
// src/lib/date.ts todayStr() on the frontend) — no time component, no
// timezone. Reject anything that isn't that exact shape, including
// calendar-invalid dates like "2026-02-30" that the regex alone would miss.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDateStr(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

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
      // Optional bulk-create for subtasks, created in the same transaction
      // as the task (see below). Accepts either plain titles or objects
      // shaped like { title } — TaskFormScreen currently sends plain
      // strings (see localSubtasks), objects are accepted too so a future
      // richer payload doesn't need a server change.
      subtasks?: (string | { title?: string })[];
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
        subtasks,
      } = req.body;

      const trimmedTitle = typeof title === "string" ? title.trim() : "";
      if (!trimmedTitle)
        return reply
          .code(400)
          .send({ error: "название задачи не может быть пустым" });

      if (
        due_date !== undefined &&
        due_date !== null &&
        (typeof due_date !== "string" || !isValidDateStr(due_date))
      ) {
        return reply
          .code(400)
          .send({ error: "некорректная дата (ожидается формат ГГГГ-ММ-ДД)" });
      }

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

      // Normalize+validate subtasks up front, before touching the DB, so a
      // bad entry 400s cleanly instead of failing mid-transaction.
      const subtaskTitles: string[] = [];
      if (subtasks !== undefined) {
        if (!Array.isArray(subtasks)) {
          return reply
            .code(400)
            .send({ error: "subtasks должен быть массивом" });
        }
        for (const item of subtasks) {
          const raw =
            typeof item === "string"
              ? item
              : typeof item?.title === "string"
                ? item.title
                : "";
          const t = raw.trim();
          if (!t)
            return reply
              .code(400)
              .send({ error: "у каждой подзадачи должно быть название" });
          subtaskTitles.push(t);
        }
      }

      const id = uid();

      // Task + labels + subtasks all land in one transaction — the frontend
      // used to POST the task, then POST each subtask separately (see
      // src/api/subtasks.ts createSubtaskRequest / TaskFormScreen), which
      // could leave an orphaned half-task if a later request failed. The
      // `subtasks` param lets a single request do it atomically instead;
      // omitting it keeps the exact old behavior (no subtasks written here).
      const createTaskTxn = db.transaction(() => {
        db.prepare(
          `
          INSERT INTO tasks (id, title, description, due_date, project_id, priority, assignee_id, creator_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ).run(
          id,
          trimmedTitle,
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

        if (subtaskTitles.length) {
          const insSub = db.prepare(
            "INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, ?, ?)",
          );
          subtaskTitles.forEach((t, i) => insSub.run(uid(), id, t, i + 1));
        }
      });
      createTaskTxn();

      // Create notification for assignee
      if (assignee_id && assignee_id !== req.userId) {
        const notifId = uid();
        db.prepare(
          "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, 'assigned', ?, ?, ?)",
        ).run(
          notifId,
          assignee_id,
          id,
          `Новая задача назначена: ${trimmedTitle}`,
          req.userId,
        );
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
      due_date: string | null;
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

      // title, when sent, must not be blank — trim now so the ALLOWED_FIELDS
      // loop below writes the trimmed value.
      if (body.title !== undefined) {
        const trimmed = typeof body.title === "string" ? body.title.trim() : "";
        if (!trimmed)
          return reply
            .code(400)
            .send({ error: "название задачи не может быть пустым" });
        body.title = trimmed;
      }
      // due_date, when sent, must be a real "YYYY-MM-DD" date or null
      // (null clears the due date — see TaskFormScreen's dueDate state).
      if (
        body.due_date !== undefined &&
        body.due_date !== null &&
        (typeof body.due_date !== "string" || !isValidDateStr(body.due_date))
      ) {
        return reply
          .code(400)
          .send({ error: "некорректная дата (ожидается формат ГГГГ-ММ-ДД)" });
      }

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
          "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, 'assigned', ?, ?, ?)",
        ).run(
          notifId,
          body.assignee_id,
          id,
          `Вас назначили на: ${existing.title || id}`,
          req.userId,
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
