import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getTaskForUser } from "../access.js";
import { broadcastToUsers } from "../ws.js";
import { logEvent, isStale } from "../agentState.js";
// Тот же расчёт state/agent_stale, что у GET /api/tasks/:id (tasks.ts) —
// иначе ответы этого файла (add/patch/delete подзадачи, WS-рассылка)
// отдают сырой agent_state вместо вычисленного state, и два места отдачи
// задачи расходятся в контракте. Максим 18.08.2026: «почини».
import { withSubtaskState } from "./tasks.js";

const uid = () => crypto.randomUUID();

/** Get full task state with assignee info, labels, subtasks, and comments. */
function getFullTask(taskId: string) {
  const full = db
    .prepare(
      `SELECT t.*, u.name as assignee_name, u.avatar_color as assignee_color, u.avatar_url as assignee_avatar_url, u.initials as assignee_initials
       FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id WHERE t.id = ?`,
    )
    .get(taskId) as any;
  if (!full) return undefined;

  const labels = db
    .prepare(
      `SELECT l.* FROM labels l JOIN task_labels tl ON tl.label_id = l.id WHERE tl.task_id = ?`,
    )
    .all(taskId);
  const subtasks = db
    .prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY position")
    .all(taskId)
    .map(withSubtaskState);
  const comments = db
    .prepare(
      `SELECT c.*, u.name as user_name, u.avatar_color as user_color, u.avatar_url as user_avatar_url, u.initials as user_initials
       FROM comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.task_id = ? ORDER BY c.created_at`,
    )
    .all(taskId);

  return { ...full, labels, subtasks, comments };
}

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

  app.post<{
    Params: { taskId: string };
    Body: { title: string; after_id?: string };
  }>("/api/tasks/:taskId/subtasks", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const task = getTaskForUser(req.params.taskId, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });
      if (!req.body?.title)
        return reply.code(400).send({ error: "title required" });

      const id = uid();

      // after_id: агент вставляет шаг НЕ в конец, а сразу после конкретного
      // уже существующего — например, между шагом 2 и 3, поняв по ходу
      // работы, что нужен ещё один. Без него — прежнее поведение (в конец).
      // Позиция сдвигается транзакцией: и освобождение места, и сама
      // вставка коммитятся вместе, иначе конкурентный запрос может
      // воткнуться между ними и увидеть дыру или дубль.
      const afterId = req.body.after_id;
      if (afterId) {
        const after = db
          .prepare("SELECT * FROM subtasks WHERE id = ? AND task_id = ?")
          .get(afterId, req.params.taskId) as any;
        if (!after) {
          return reply
            .code(400)
            .send({ error: "after_id: подзадача не найдена в этой задаче" });
        }
        db.transaction(() => {
          db.prepare(
            "UPDATE subtasks SET position = position + 1 WHERE task_id = ? AND position > ?",
          ).run(req.params.taskId, after.position);
          db.prepare(
            "INSERT INTO subtasks (id, task_id, title, position) VALUES (?,?,?,?)",
          ).run(id, req.params.taskId, req.body.title, after.position + 1);
        })();
      } else {
        const maxPos = db
          .prepare(
            "SELECT COALESCE(MAX(position),0) as m FROM subtasks WHERE task_id = ?",
          )
          .get(req.params.taskId) as any;
        db.prepare(
          "INSERT INTO subtasks (id, task_id, title, position) VALUES (?,?,?,?)",
        ).run(id, req.params.taskId, req.body.title, maxPos.m + 1);
      }
      const subtask = withSubtaskState(
        db.prepare("SELECT * FROM subtasks WHERE id = ?").get(id),
      );

      logEvent({
        taskId: req.params.taskId,
        actorId: req.userId,
        kind: "subtask_added",
        field: "subtask",
        toValue: req.body.title,
      });

      const fullTask = getFullTask(req.params.taskId);
      broadcastToUsers([task.creator_id, task.assignee_id], {
        type: "task:updated",
        task: fullTask,
      });
      return subtask;
    },
  });

  app.patch<{
    Params: { id: string };
    Body: { done?: boolean; title?: string; position?: number };
  }>("/api/subtasks/:id", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const subtask = getSubtaskWithTaskForUser(req.params.id, req.userId);
      if (!subtask) return reply.code(404).send({ error: "Not found" });

      const { done, title, position } = req.body || {};
      if (position !== undefined && !Number.isInteger(position)) {
        return reply.code(400).send({ error: "position must be an integer" });
      }
      // Приёмка за человеком (симметрично «completed для type='ai' —
      // 403» у самой задачи, agent-state.ts): агент не может сам поставить
      // готово шагу, который сам же сдал на проверку — иначе review ничего
      // не защищает, просто лишняя кнопка перед тем же самообслуживанием.
      if (done === true && subtask.agent_state === "review") {
        const caller = db
          .prepare("SELECT type FROM users WHERE id = ?")
          .get(req.userId) as { type?: string } | undefined;
        if (caller?.type === "ai") {
          return reply.code(403).send({
            error: "принять шаг с проверки может только владелец задачи",
          });
        }
      }
      if (done !== undefined) {
        db.prepare("UPDATE subtasks SET done = ? WHERE id = ?").run(
          done ? 1 : 0,
          req.params.id,
        );
        // Галочка на шаге — такое же событие задачи, как и всё остальное:
        // в ленте видно, кто именно отметил шаг сделанным (или снял
        // отметку). Пишем только при реальной смене, чтобы повторный
        // PATCH тем же значением не плодил одинаковые строки.
        if (!!subtask.done !== !!done) {
          logEvent({
            taskId: subtask.task_id,
            actorId: req.userId,
            kind: done ? "subtask_done" : "subtask_undone",
            field: "subtask",
            toValue: title ?? subtask.title,
          });
        }
      }
      if (title) {
        db.prepare("UPDATE subtasks SET title = ? WHERE id = ?").run(
          title,
          req.params.id,
        );
        if (title !== subtask.title) {
          logEvent({
            taskId: subtask.task_id,
            actorId: req.userId,
            kind: "subtask_renamed",
            field: "subtask",
            fromValue: subtask.title,
            toValue: title,
          });
        }
      }
      // position — то же самое ручное перетаскивание, что уже есть у задач
      // на доске (tasks.ts): сознательно НЕ журналируем — то же обоснование,
      // портянка из «шаг переставлен» на каждый пиксель драга никому не
      // нужна. Broadcast всё равно уходит — по нему обновится список.
      if (position !== undefined) {
        db.prepare("UPDATE subtasks SET position = ? WHERE id = ?").run(
          position,
          req.params.id,
        );
      }

      const fullTask = getFullTask(subtask.task_id);
      broadcastToUsers([subtask.task_creator_id, subtask.task_assignee_id], {
        type: "task:updated",
        task: fullTask,
      });
      return withSubtaskState(
        db.prepare("SELECT * FROM subtasks WHERE id = ?").get(req.params.id),
      );
    },
  });

  // ═══════ РАБОТА АГЕНТА НАД ПОДЗАДАЧЕЙ ═══════
  //
  // Зачем: до 15.08.2026 по карточке было видно только «агент взял задачу» и
  // «сдал», а где он внутри — нет. Подзадача умела ровно одно: галочку по
  // факту. Теперь агент отмечает НАЧАЛО работы над конкретной подзадачей, и
  // в ленте видно, где он сейчас.
  //
  // Аренда та же, что у задачи, и по той же причине (см. AGENT-PROTOCOL.md
  // и заметку про ручное продление): «в работе» держится СИГНАЛАМИ, а не
  // выставляется раз и навсегда. Замолчал дольше срока — подзадача больше не
  // показывается работающей. Индикатор, который горит без работы, хуже
  // отсутствующего: ровно от этого весь протокол и защищает.
  app.post<{
    Params: { id: string };
    Body: {
      state?: "in_progress" | "blocked" | "review" | null;
      result?: string;
    };
  }>("/api/subtasks/:id/work", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const subtask = getSubtaskWithTaskForUser(req.params.id, req.userId);
      if (!subtask) return reply.code(404).send({ error: "Not found" });

      const { state, result } = req.body || {};
      const known =
        state === undefined ||
        state === null ||
        state === "in_progress" ||
        state === "blocked" ||
        state === "review";
      if (!known) {
        return reply
          .code(400)
          .send({ error: "state: in_progress | blocked | review | null" });
      }

      // review — то же самое, что review у задачи (AGENT-PROTOCOL.md):
      // агент сдаёт шаг, объяснив, что сделал. Пустой result здесь так же
      // недопустим, как пустой комментарий у задачи в review/blocked —
      // владелец «прощёлкивает» шаги пачкой позже (не сразу), без текста
      // ему нечего оценивать.
      if (state === "review" && !result && !subtask.result) {
        return reply
          .code(400)
          .send({ error: "result обязателен: что сделано в этом шаге" });
      }

      // Выход ИЗ review — человек, не агент. НЕ по creator_id (18.08.2026,
      // поправка после демо: «в большинстве случаев создавать задачи будешь
      // ты» — агент часто и есть создатель, привязка к creator_id заперла
      // бы решение по review именно на него, а не на живого владельца).
      // Симметрично task-level защите «completed отклоняется для
      // type='ai'» (agent-state.ts) — тот же принцип, та же причина: агент,
      // сдавший шаг на проверку, не должен сам же его и забрать обратно.
      if (subtask.agent_state === "review" && state !== "review") {
        const caller = db
          .prepare("SELECT type FROM users WHERE id = ?")
          .get(req.userId) as { type?: string } | undefined;
        if (caller?.type === "ai") {
          return reply.code(403).send({
            error: "вернуть шаг из проверки может только человек-владелец",
          });
        }
      }

      // Чужую подзадачу не перехватываем: пока живой держит аренду, второй
      // исполнитель получает отказ — та же защита, что у задачи, иначе два
      // агента напишут разный итог в одну строку.
      const занята =
        subtask.agent_state === "in_progress" &&
        subtask.agent_id &&
        subtask.agent_id !== req.userId &&
        !isStale(subtask.agent_heartbeat_at);
      if (занята && state === "in_progress") {
        return reply
          .code(409)
          .send({ error: "Над подзадачей уже работает другой исполнитель" });
      }

      if (state !== undefined) {
        if (state === null) {
          db.prepare(
            "UPDATE subtasks SET agent_state = NULL, agent_id = NULL, agent_heartbeat_at = NULL WHERE id = ?",
          ).run(req.params.id);
        } else {
          db.prepare(
            `UPDATE subtasks
                SET agent_state = ?, agent_id = ?, agent_heartbeat_at = datetime('now')
              WHERE id = ?`,
          ).run(state, req.userId, req.params.id);
        }
      } else {
        // Тело без state — это продление аренды. Трогаем ТОЛЬКО отметку
        // времени, как и heartbeat у задачи: сигнал не меняет ничего, кроме
        // «я ещё здесь».
        db.prepare(
          "UPDATE subtasks SET agent_heartbeat_at = datetime('now') WHERE id = ?",
        ).run(req.params.id);
      }

      if (result !== undefined) {
        db.prepare("UPDATE subtasks SET result = ? WHERE id = ?").run(
          result || null,
          req.params.id,
        );
      }

      // В журнал — только смена состояния, не каждый сигнал: иначе лента
      // задачи утонет в служебных отметках раз в полторы минуты.
      // subtask_returned (не subtask_released) — когда null приходит ИЗ
      // review: это не агент сам отпустил шаг, это владелец вернул его на
      // доработку, и в ленте это должно читаться иначе (см. проверку прав
      // выше — сюда доходит только владелец).
      if (state !== undefined && state !== subtask.agent_state) {
        logEvent({
          taskId: subtask.task_id,
          actorId: req.userId,
          kind:
            state === "in_progress"
              ? "subtask_started"
              : state === "blocked"
                ? "subtask_blocked"
                : state === "review"
                  ? "subtask_review"
                  : subtask.agent_state === "review"
                    ? "subtask_returned"
                    : "subtask_released",
          field: "subtask",
          toValue: subtask.title,
        });
      }

      const fullTask = getFullTask(subtask.task_id);
      broadcastToUsers([subtask.task_creator_id, subtask.task_assignee_id], {
        type: "task:updated",
        task: fullTask,
      });
      return withSubtaskState(
        db.prepare("SELECT * FROM subtasks WHERE id = ?").get(req.params.id),
      );
    },
  });

  app.delete<{ Params: { id: string } }>(
    "/api/subtasks/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const subtask = getSubtaskWithTaskForUser(req.params.id, req.userId);
      if (!subtask) return reply.code(404).send({ error: "Not found" });

      db.prepare("DELETE FROM subtasks WHERE id = ?").run(req.params.id);
      logEvent({
        taskId: subtask.task_id,
        actorId: req.userId,
        kind: "subtask_removed",
        field: "subtask",
        fromValue: subtask.title,
      });
      const fullTask = getFullTask(subtask.task_id);
      broadcastToUsers([subtask.task_creator_id, subtask.task_assignee_id], {
        type: "task:updated",
        task: fullTask,
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
          `SELECT c.*, u.name as user_name, u.avatar_color as user_color, u.avatar_url as user_avatar_url, u.initials as user_initials
         FROM comments c LEFT JOIN users u ON c.user_id = u.id
         WHERE c.task_id = ? ORDER BY c.created_at`,
        )
        .all(req.params.taskId);
    },
  );

  app.post<{
    Params: { taskId: string };
    Body: { text: string; attachment_ids?: string[] };
  }>("/api/tasks/:taskId/comments", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const task = getTaskForUser(req.params.taskId, req.userId) as any;
      if (!task) return reply.code(404).send({ error: "Not found" });
      const attachmentIds: string[] = Array.isArray(req.body?.attachment_ids)
        ? req.body.attachment_ids
        : [];
      // Пустой текст допустим, когда приложены файлы: «вот скриншот» без
      // подписи — нормальный комментарий, требовать к нему слова незачем.
      // А вот пустой комментарий совсем без ничего — по-прежнему 400.
      if (!req.body?.text && attachmentIds.length === 0)
        return reply.code(400).send({ error: "text required" });

      const id = uid();
      db.prepare(
        "INSERT INTO comments (id, task_id, user_id, text) VALUES (?,?,?,?)",
      ).run(id, req.params.taskId, req.userId, req.body.text ?? "");

      // Файлы загружаются заранее и лежат «ничьими» (comment_id = NULL) —
      // здесь они подбираются отправленным комментарием. Берём только свои
      // и только по этой задаче: чужое вложение чужой карточки к своему
      // комментарию не привяжется, даже если знать его идентификатор.
      if (attachmentIds.length) {
        const attach = db.prepare(
          `UPDATE attachments SET comment_id = ?
             WHERE id = ? AND task_id = ? AND user_id = ? AND comment_id IS NULL`,
        );
        for (const attId of attachmentIds) {
          attach.run(id, attId, req.params.taskId, req.userId);
        }
      }

      // Notify the other party (creator or assignee, whichever isn't the commenter)
      const notifyTarget =
        task.assignee_id === req.userId ? task.creator_id : task.assignee_id;
      if (notifyTarget && notifyTarget !== req.userId) {
        const user = db
          .prepare("SELECT name FROM users WHERE id = ?")
          .get(req.userId) as any;
        const notifId = uid();
        db.prepare(
          "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, 'commented', ?, ?, ?)",
        ).run(
          notifId,
          notifyTarget,
          req.params.taskId,
          `${user?.name || "Кто-то"} прокомментировал: ${task.title}`,
          req.userId,
        );
        broadcastToUsers([notifyTarget], {
          type: "notification:new",
          notificationId: notifId,
          taskId: req.params.taskId,
        });
      }

      return db
        .prepare(
          `SELECT c.*, u.name as user_name, u.avatar_color as user_color, u.avatar_url as user_avatar_url, u.initials as user_initials
           FROM comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.id = ?`,
        )
        .get(id);
    },
  });
}
