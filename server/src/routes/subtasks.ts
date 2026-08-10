import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getTaskForUser } from "../access.js";
import { broadcastToUsers } from "../ws.js";

const uid = () => crypto.randomUUID();

/** The task a subtask belongs to, joined and ownership-checked in one query. */
function getSubtaskWithTaskForUser(
  subtaskId: string,
  userId: string,
): any | undefined {
  return db
    .prepare(
      `SELECT s.*, t.creator_id as task_creator_id, t.assignee_id as task_assignee_id
       FROM subtasks s JOIN tasks t ON t.id = s.task_id
       WHERE s.id = ? AND (t.creator_id = ? OR t.assignee_id = ?)`,
    )
    .get(subtaskId, userId, userId);
}

/** The comment's parent task, joined and ownership-checked in one query. */
function getCommentWithTaskForUser(
  commentId: string,
  userId: string,
): any | undefined {
  return db
    .prepare(
      `SELECT c.*, t.creator_id as task_creator_id, t.assignee_id as task_assignee_id
       FROM comments c JOIN tasks t ON t.id = c.task_id
       WHERE c.id = ? AND (t.creator_id = ? OR t.assignee_id = ?)`,
    )
    .get(commentId, userId, userId);
}

export function registerSubtaskCommentRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // ── Subtasks ── all scoped to a task the caller may access (creator or assignee).
  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/subtasks",
    { preHandler: authPre },
    async (req: any, reply) => {
      const task = getTaskForUser(req.params.taskId, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });
      return db
        .prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY position")
        .all(req.params.taskId);
    },
  );

  app.post<{ Params: { taskId: string }; Body: { title: string } }>(
    "/api/tasks/:taskId/subtasks",
    {
      preHandler: authPre,
      handler: async (req: any, reply) => {
        const task = getTaskForUser(req.params.taskId, req.userId);
        if (!task) return reply.code(404).send({ error: "Not found" });
        if (!req.body?.title)
          return reply.code(400).send({ error: "title required" });

        const id = uid();
        const maxPos = db
          .prepare(
            "SELECT COALESCE(MAX(position),0) as m FROM subtasks WHERE task_id = ?",
          )
          .get(req.params.taskId) as any;
        db.prepare(
          "INSERT INTO subtasks (id, task_id, title, position) VALUES (?,?,?,?)",
        ).run(id, req.params.taskId, req.body.title, maxPos.m + 1);
        const subtask = db
          .prepare("SELECT * FROM subtasks WHERE id = ?")
          .get(id);

        broadcastToUsers([task.creator_id, task.assignee_id], {
          type: "task:updated",
          taskId: req.params.taskId,
        });
        return subtask;
      },
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { done?: boolean; title?: string };
  }>("/api/subtasks/:id", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const subtask = getSubtaskWithTaskForUser(req.params.id, req.userId);
      if (!subtask) return reply.code(404).send({ error: "Not found" });

      const { done, title } = req.body || {};
      if (done !== undefined)
        db.prepare("UPDATE subtasks SET done = ? WHERE id = ?").run(
          done ? 1 : 0,
          req.params.id,
        );
      if (title)
        db.prepare("UPDATE subtasks SET title = ? WHERE id = ?").run(
          title,
          req.params.id,
        );

      broadcastToUsers([subtask.task_creator_id, subtask.task_assignee_id], {
        type: "task:updated",
        taskId: subtask.task_id,
      });
      return db
        .prepare("SELECT * FROM subtasks WHERE id = ?")
        .get(req.params.id);
    },
  });

  app.delete<{ Params: { id: string } }>(
    "/api/subtasks/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const subtask = getSubtaskWithTaskForUser(req.params.id, req.userId);
      if (!subtask) return reply.code(404).send({ error: "Not found" });

      db.prepare("DELETE FROM subtasks WHERE id = ?").run(req.params.id);
      broadcastToUsers([subtask.task_creator_id, subtask.task_assignee_id], {
        type: "task:updated",
        taskId: subtask.task_id,
      });
      return { ok: true };
    },
  );

  // ── Comments ── same task-ownership scoping.
  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/comments",
    { preHandler: authPre },
    async (req: any, reply) => {
      const task = getTaskForUser(req.params.taskId, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });
      return db
        .prepare(
          `SELECT c.*, u.name as user_name, u.avatar_color as user_color, u.initials as user_initials
         FROM comments c LEFT JOIN users u ON c.user_id = u.id
         WHERE c.task_id = ? ORDER BY c.created_at`,
        )
        .all(req.params.taskId);
    },
  );

  app.post<{ Params: { taskId: string }; Body: { text: string } }>(
    "/api/tasks/:taskId/comments",
    {
      preHandler: authPre,
      handler: async (req: any, reply) => {
        const task = getTaskForUser(req.params.taskId, req.userId) as any;
        if (!task) return reply.code(404).send({ error: "Not found" });
        if (!req.body?.text)
          return reply.code(400).send({ error: "text required" });

        const id = uid();
        db.prepare(
          "INSERT INTO comments (id, task_id, user_id, text) VALUES (?,?,?,?)",
        ).run(id, req.params.taskId, req.userId, req.body.text);

        // Notify the other party (creator or assignee, whichever isn't the commenter)
        const notifyTarget =
          task.assignee_id === req.userId ? task.creator_id : task.assignee_id;
        if (notifyTarget && notifyTarget !== req.userId) {
          const user = db
            .prepare("SELECT name FROM users WHERE id = ?")
            .get(req.userId) as any;
          const notifId = uid();
          db.prepare(
            "INSERT INTO notifications (id, user_id, type, task_id, text) VALUES (?, ?, 'commented', ?, ?)",
          ).run(
            notifId,
            notifyTarget,
            req.params.taskId,
            `${user?.name || "Кто-то"} прокомментировал: ${task.title}`,
          );
          broadcastToUsers([notifyTarget], {
            type: "notification:new",
            notificationId: notifId,
            taskId: req.params.taskId,
          });
        }

        return db
          .prepare(
            `SELECT c.*, u.name as user_name, u.avatar_color as user_color, u.initials as user_initials
           FROM comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.id = ?`,
          )
          .get(id);
      },
    },
  );
}
