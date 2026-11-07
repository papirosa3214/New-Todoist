// HTTP-маршруты обсуждения работающей карточки (карточка 252c400e,
// этапы 3–4 плана).
//
// Обсуждение — отдельная сущность, не режим комнаты (контракт
// архитектора f3ada2e0, §1.3): своя комната, свой жизненный цикл,
// свой итог и handoff. Маршруты:
//
//   POST /api/tasks/:taskId/discussions        — открыть обсуждение
//   GET  /api/tasks/:taskId/discussions        — список обсуждений карточки
//   GET  /api/discussions/:id                  — состояние обсуждения
//   POST /api/discussions/:id/messages         — реплика владельца (ответ роли)
//   POST /api/discussions/:id/close            — закрыть: итог + handoff
//   POST /api/discussions/:id/accept           — принять handoff (нужна квитанция)
//
// Права: обсуждение открывает и закрывает владелец карточки; реплики
// владельца идут в обсуждение, а НЕ в рабочий ход исполнителя.

import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getTaskForRead, isOwner } from "../access.js";
import { roleUserId } from "../roleRouting.js";
import { slotWorkspace } from "../runtime/inProcessRun.js";
import {
  acceptHandoff,
  closeDiscussion,
  deliverDiscussionHandoff,
  handoffReceipt,
  listDiscussions,
  openDiscussion,
  readDiscussion,
  readHandoff,
} from "../runtime/taskDiscussion.js";
import { discussionSnapshot, runDiscussionTurn } from "../runtime/taskDiscussionSession.js";

export async function registerTaskDiscussionRoutes(app: FastifyInstance): Promise<void> {
  const authPre = authOrApiToken;

  /** Роль по учётке (учётка роли → ключ роли). */
  function roleKeyOf(userId: string): string | null {
    const row = db
      .prepare("SELECT role_key,type FROM users WHERE id=?")
      .get(userId) as { role_key: string | null; type: string | null } | undefined;
    if (!row || row.type !== "ai" || !row.role_key) return null;
    return row.role_key;
  }

  app.post<{
    Params: { taskId: string };
    Body: { subtask_id?: string; role?: string; title?: string };
  }>("/api/tasks/:taskId/discussions", { preHandler: authPre }, async (req: any, reply) => {
    const task = getTaskForRead(req.params.taskId, req.userId);
    if (!task) return reply.code(404).send({ error: "Задача не найдена" });
    if (!isOwner(req.userId) || roleKeyOf(req.userId))
      return reply.code(403).send({ error: "Обсуждение открывает владелец" });
    const subtaskId = typeof req.body?.subtask_id === "string" ? req.body.subtask_id : null;
    const role = typeof req.body?.role === "string" ? req.body.role : null;
    if (!subtaskId || !role)
      return reply.code(400).send({ error: "Нужны subtask_id и role" });
    const slot = db
      .prepare("SELECT id,task_id,agent_id FROM subtasks WHERE id=? AND task_id=?")
      .get(subtaskId, req.params.taskId) as { id: string; task_id: string; agent_id: string | null } | undefined;
    if (!slot) return reply.code(404).send({ error: "Этап не найден в этой карточке" });
    if (!slot.agent_id) return reply.code(409).send({ error: "У этапа нет исполнителя" });
    const { discussion } = openDiscussion({
      taskId: req.params.taskId,
      subtaskId,
      role,
      ownerUserId: req.userId,
      title: typeof req.body?.title === "string" ? req.body.title : undefined,
    });
    return reply.code(201).send({ discussion: discussionSnapshot(discussion.discussion_id) });
  });

  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/discussions",
    { preHandler: authPre },
    async (req: any, reply) => {
      const task = getTaskForRead(req.params.taskId, req.userId);
      if (!task) return reply.code(404).send({ error: "Задача не найдена" });
      return { discussions: listDiscussions(req.params.taskId).map((row) => discussionSnapshot(row.discussion_id)) };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/discussions/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const discussion = readDiscussion(req.params.id);
      if (!discussion) return reply.code(404).send({ error: "Обсуждение не найдено" });
      if (!getTaskForRead(discussion.task_id, req.userId))
        return reply.code(404).send({ error: "Обсуждение не найдено" });
      const handoff = discussion.handoff_id ? readHandoff(discussion.handoff_id) : null;
      return {
        discussion: discussionSnapshot(req.params.id),
        handoff: handoff
          ? {
              handoff_id: handoff.handoff_id,
              version: handoff.version,
              state: handoff.state,
              recipient_subtask_id: handoff.recipient_subtask_id,
              receipt: handoffReceipt(handoff.handoff_id),
            }
          : null,
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    "/api/discussions/:id/messages",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isOwner(req.userId) || roleKeyOf(req.userId))
        return reply.code(403).send({ error: "Реплики обсуждения отправляет владелец" });
      const discussion = readDiscussion(req.params.id);
      if (!discussion) return reply.code(404).send({ error: "Обсуждение не найдено" });
      if (!getTaskForRead(discussion.task_id, req.userId))
        return reply.code(404).send({ error: "Обсуждение не найдено" });
      const text = String(req.body?.text ?? "").trim();
      if (!text) return reply.code(400).send({ error: "Пустая реплика" });
      if (discussion.state !== "open")
        return reply.code(409).send({ error: "Обсуждение закрыто: новые реплики не принимаются" });
      db.prepare(
        "INSERT INTO chat_messages (id,from_user_id,text,channel,chat_id,task_id) VALUES (?,?,?,'chat',?,?)",
      ).run(`dm_${Date.now()}_${Math.random().toString(16).slice(2)}`, req.userId, text, discussion.chat_id, discussion.task_id);
      const result = await runDiscussionTurn({
        discussionId: discussion.discussion_id,
        role: roleKeyOf(discussion.role_id) ?? "builder",
        prompt: text,
        cwd: slotWorkspace(discussion.task_id),
      });
      if (!result.ok)
        return reply.code(502).send({ error: result.error ?? "Ответ роли не получен", discussion: discussionSnapshot(discussion.discussion_id) });
      return { discussion: discussionSnapshot(discussion.discussion_id), reply: result.text };
    },
  );

  app.post<{ Params: { id: string }; Body: { recipient_subtask_id?: string } }>(
    "/api/discussions/:id/close",
    { preHandler: authPre },
    async (req: any, reply) => {
      const discussion = readDiscussion(req.params.id);
      if (!discussion) return reply.code(404).send({ error: "Обсуждение не найдено" });
      if (!isOwner(req.userId) || roleKeyOf(req.userId))
        return reply.code(403).send({ error: "Обсуждение закрывает владелец" });
      if (!getTaskForRead(discussion.task_id, req.userId))
        return reply.code(404).send({ error: "Обсуждение не найдено" });
      let closed: Awaited<ReturnType<typeof closeDiscussion>>;
      try {
        closed = await closeDiscussion({
        discussionId: discussion.discussion_id,
        actorUserId: req.userId,
        recipientSubtaskId:
          typeof req.body?.recipient_subtask_id === "string" ? req.body.recipient_subtask_id : null,
      });
      } catch (error) {
        if ((error as {code?: string}).code === "DISCUSSION_ANSWER_PENDING")
          return reply.code(409).send({error: "Ответ обсуждения ещё не завершён", discussion: discussionSnapshot(discussion.discussion_id)});
        throw error;
      }
      let delivery = closed.delivery;
      if (closed.handoff) {
        delivery = await deliverDiscussionHandoff({
          discussionId: discussion.discussion_id,
          handoffId: closed.handoff.handoff_id,
        });
      }
      return {
        discussion: discussionSnapshot(discussion.discussion_id),
        summary: closed.summary,
        handoff: closed.handoff
          ? {
              handoff_id: closed.handoff.handoff_id,
              version: closed.handoff.version,
              state: closed.handoff.state,
              recipient_subtask_id: closed.handoff.recipient_subtask_id,
            }
          : null,
        delivery,
        repeated: closed.repeated,
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/discussions/:id/accept",
    { preHandler: authPre },
    async (req: any, reply) => {
      const discussion = readDiscussion(req.params.id);
      if (!discussion) return reply.code(404).send({ error: "Обсуждение не найдено" });
      if (!isOwner(req.userId) || roleKeyOf(req.userId))
        return reply.code(403).send({ error: "Обязательство принимает владелец" });
      if (!discussion.handoff_id)
        return reply.code(409).send({ error: "Обязательства ещё нет: обсуждение не закрыто" });
      const result = acceptHandoff({ handoffId: discussion.handoff_id, actorUserId: req.userId });
      if (!result.ok) return reply.code(409).send({ error: result.reason });
      return { discussion: discussionSnapshot(discussion.discussion_id) };
    },
  );
}
