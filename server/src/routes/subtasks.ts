import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { authOrApiToken, sessionOf } from "../auth.js";
import { getTaskForRead, getTaskForWrite } from "../access.js";
import { broadcastToUsers } from "../ws.js";
import {
  AGENT_RULES,
  logEvent,
  isStale,
  subtaskWorkRefusal,
} from "../agentState.js";
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

/**
 * Подзадача вместе с её задачей — и только если вызывающий вправе эту задачу
 * ПРАВИТЬ. Предикат владения больше не зашит в запрос: правило зависит от
 * роли (владельцу — любая задача, агенту — своя), и живёт оно в одном месте,
 * в access.ts. Раньше здесь стояло собственное `creator_id = ? OR
 * assignee_id = ?`, из-за чего владелец не мог тронуть шаг в задаче,
 * которую агент завёл сам.
 */
function getSubtaskWithTaskForUser(
  subtaskId: string,
  userId: string,
): any | undefined {
  const subtask = db
    .prepare(
      `SELECT s.*, t.creator_id as task_creator_id, t.assignee_id as task_assignee_id,
              t.agent_state as task_agent_state
       FROM subtasks s JOIN tasks t ON t.id = s.task_id
       WHERE s.id = ?`,
    )
    .get(subtaskId) as any;
  if (!subtask) return undefined;
  return getTaskForWrite(subtask.task_id, userId) ? subtask : undefined;
}

export function registerSubtaskCommentRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // ── Subtasks ── all scoped to a task the caller may access (creator or assignee).
  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/subtasks",
    { preHandler: authPre },
    async (req: any, reply) => {
      const task = getTaskForRead(req.params.taskId, req.userId);
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
      const task = getTaskForWrite(req.params.taskId, req.userId);
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
      // Шаг закрывает тот, кто его сделал, — включая агента.
      //
      // Утром 20.08.2026 здесь стоял обратный запрет: агент обязан был
      // сдавать шаг на приёмку владельцу. К вечеру того же дня Максим
      // отменил его, поработав по этому конвейеру руками: «понту мне вот
      // эту проверку делать особой нет — если ты выполнил, я посмотрю, мне
      // что-то не нравится, я комментарий напишу или новую задачу создам.
      // Это лишнее телодвижение, убирай ревью из процессов».
      //
      // Контроль качества никуда не делся, он просто переехал: владелец
      // смотрит РЕЗУЛЬТАТ и заводит новую работу, если тот не устраивает,
      // вместо того чтобы прощёлкивать галочки за агентом. `result` («что
      // вышло») и состояние review остаются доступными — они полезны,
      // когда шаг правда нужно показать до закрытия, — но обязательными
      // больше не являются.
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

      // Правила самого конвейера — одной функцией в agentState.ts рядом с
      // матрицей переходов задачи: взять шаг можно только под взятой
      // задачей, сдать — только побывав в работе, заблокировать и сдать —
      // только с текстом. Раньше здесь лежала одна из этих проверок
      // россыпью; правила конвейера должны жить в одном месте, иначе
      // разъедутся, как разъезжались копии матрицы переходов.
      const caller = db
        .prepare("SELECT type FROM users WHERE id = ?")
        .get(req.userId) as { type?: string } | undefined;
      const refusal = subtaskWorkRefusal({
        from: subtask.agent_state ?? null,
        to: state,
        isAi: caller?.type === "ai",
        taskAgentState: subtask.task_agent_state ?? null,
        hasResult: Boolean(result || subtask.result),
        resultLength: (result ?? "").length,
      });
      if (refusal) {
        return reply.code(refusal.code).send({ error: refusal.error });
      }

      // Выход из review агенту тоже открыт — вместе с отменой обязательной
      // приёмки (20.08.2026) запирать шаг в этом состоянии стало не от чего:
      // review теперь добровольный способ показать работу, а не воронка, из
      // которой выпустить может только владелец.

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
          // Вместе с состоянием запоминаем СЕССИЮ, которая физически ведёт
          // этот шаг. Учётка агента одна на все сессии и на всех агентов,
          // поэтому без этой метки чужая работа выглядит своей — Максим
          // 20.08.2026: «другие сессии к этой задаче отношения не имеют,
          // не должно тебя дёргать».
          db.prepare(
            `UPDATE subtasks
                SET agent_state = ?, agent_id = ?, agent_session_id = ?,
                    agent_heartbeat_at = datetime('now')
              WHERE id = ?`,
          ).run(state, req.userId, sessionOf(req), req.params.id);
          // Сессию поднимаем и на саму задачу, если та её ещё не знает:
          // работа по шагам идёт без claim, и иначе задача остаётся ничьей.
          db.prepare(
            "UPDATE tasks SET agent_session_id = COALESCE(agent_session_id, ?) WHERE id = ?",
          ).run(sessionOf(req), subtask.task_id);
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
      const updated: any = withSubtaskState(
        db.prepare("SELECT * FROM subtasks WHERE id = ?").get(req.params.id),
      );
      // Взял шаг в работу — получи правила, как их писать. Тем же ответом,
      // без отдельного запроса и без надежды, что агент их где-то читал.
      return state === "in_progress"
        ? { ...updated, rules: AGENT_RULES }
        : updated;
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
      const task = getTaskForRead(req.params.taskId, req.userId);
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
      const task = getTaskForWrite(req.params.taskId, req.userId) as any;
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
             WHERE id = ? AND task_id = ? AND user_id = ?
               AND comment_id IS NULL AND kind = 'comment'`,
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
