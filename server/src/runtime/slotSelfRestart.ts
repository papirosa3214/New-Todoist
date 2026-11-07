// Самозамена исполнителя: роль просит, владелец одобряет (владелец 07.11.2026).
//
// «Без меня никто ничего не сделает» — главный ограничитель. Поэтому вызов
// роли НЕ перезапускает слот: он заводит заявку и задаёт владельцу вопрос с
// двумя кнопками. Замена выполняется только в `applySlotReplacementAnswer`,
// когда владелец выбрал «Заменить».
//
// Что проверяется до вопроса (иначе роль завалит владельца бессмысленными
// заявками):
//   * слот принадлежит этой же роли (менять чужую роль нельзя);
//   * шаг незавершён, задача активна, план утверждён (это же проверит
//     restartOccupiedSlot, но спрашивать владельца заранее глупо);
//   * слот действительно завис: нет живого запуска или heartbeat старше порога;
//   * заявок по этому слоту не больше лимита — иначе роль уйдёт в цикл
//     «завис → попросил → завис» и будет дёргать владельца.
import crypto from "node:crypto";
import db from "../db.js";
import { broadcastToUsers } from "../ws.js";
import { loadChatMessage } from "../lib/chatMessages.js";
import { createQuestionRow, renderQuestionText, type QuestionPayload } from "../lib/chatQuestions.js";
import { liveInterruptEvent, liveResumeEvent, waitForAnswer } from "../lib/questionWait.js";
import { activeInProcessRun } from "./inProcessRun.js";
import { roleUserId } from "../roleRouting.js";
import {
  attachQuestion,
  expireStaleRequests,
  requestSlotReplacement,
  SLOT_REQUEST_TTL_MINUTES,
  slotReplacementRequest,
  type SlotReplacementRequest,
} from "./slotReplacementRequest.js";
import { applySlotReplacementAnswer } from "./slotReplacementApply.js";
/** Сколько минут без heartbeat считаем зависанием (как у сторожа шагов). */
export const SLOT_STALL_MINUTES = 10;
/** Сколько самозамен по одному слоту допускаем за сутки. */
export const SLOT_SELF_REPLACE_DAILY_LIMIT = 3;
/** Вариант «да» в кнопке. По этой метке и решается замена. */
export const APPROVE_LABEL = "Заменить";
export const REJECT_LABEL = "Не заменять";

export type SelfRestartOutcome =
  | { status: "applied"; request: SlotReplacementRequest }
  | { status: "rejected"; request: SlotReplacementRequest }
  | { status: "open"; request: SlotReplacementRequest; messageId: string }
  | { status: "failed"; request: SlotReplacementRequest; error: string };

/** Почему слот нельзя считать зависшим — или null, если можно. */
function slotStallReason(subtaskId: string): string | null {
  const row = db
    .prepare(
      `SELECT s.id, s.task_id, s.done, s.agent_heartbeat_at, n.role_key, n.skipped_at,
              t.status AS task_status, p.status AS plan_status
         FROM subtasks s
         JOIN task_collaboration_plan_nodes n
           ON n.plan_id = s.collaboration_plan_id AND n.slot_key = s.plan_node_key
         JOIN tasks t ON t.id = s.task_id
         JOIN task_collaboration_plans p ON p.id = n.plan_id
        WHERE s.id = ?`,
    )
    .get(subtaskId) as
    | {
        id: string;
        task_id: string;
        done: number;
        agent_heartbeat_at: string | null;
        role_key: string;
        skipped_at: string | null;
        task_status: string;
        plan_status: string;
      }
    | undefined;
  if (!row) return "Слот не найден";
  if (row.done) return "Шаг уже закрыт — заменять нечего";
  if (row.skipped_at) return "Шаг пропущен — заменять нечего";
  if (row.task_status !== "active") return "Задача не в работе — заменять нечего";
  if (row.plan_status !== "approved") return "План не утверждён — заменять нечего";
  // Живой запуск есть и heartbeat свежий — это не зависание, а работа.
  const run = activeInProcessRun(row.task_id, row.id);
  const fresh =
    row.agent_heartbeat_at &&
    Date.now() - Date.parse(row.agent_heartbeat_at.replace(" ", "T") + "Z") < SLOT_STALL_MINUTES * 60_000;
  if (run && fresh) return "Слот работает прямо сейчас — не завис";
  return null;
}

/** Сколько самозамен по слоту уже было за сутки. */
function replacementsToday(subtaskId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM slot_replacement_requests
          WHERE subtask_id = ? AND status IN ('approved','applied')
            AND created_at >= datetime('now','-1 day')`,
      )
      .get(subtaskId) as { n: number }
  ).n;
}

/**
 * Роль просит заменить свой слот. Возвращает исход: заменено (если владелец
 * ответил в этом же ходе), отклонено, ожидает ответа или сбой.
 */
export async function requestSelfRestart(args: {
  chatId: string;
  messageId: string;
  role: string;
  roleAccountId: string;
  subtaskId: string;
  reason: string;
  signal?: AbortSignal;
}): Promise<SelfRestartOutcome> {
  expireStaleRequests();
  const stall = slotStallReason(args.subtaskId);
  if (stall) throw new Error(stall);

  const row = db
    .prepare(
      `SELECT n.role_key FROM subtasks s
         JOIN task_collaboration_plan_nodes n
           ON n.plan_id = s.collaboration_plan_id AND n.slot_key = s.plan_node_key
        WHERE s.id = ?`,
    )
    .get(args.subtaskId) as { role_key: string } | undefined;
  if (!row) throw new Error("Слот не найден");
  if (row.role_key !== args.role) throw new Error("Заменить можно только слот своей же роли");

  if (replacementsToday(args.subtaskId) >= SLOT_SELF_REPLACE_DAILY_LIMIT) {
    throw new Error(
      `Сегодня по этому слоту уже было ${SLOT_SELF_REPLACE_DAILY_LIMIT} замены — больше не прошу. Нужен разбор владельца или Оркестратора.`,
    );
  }

  const taskId = (db.prepare("SELECT task_id FROM subtasks WHERE id = ?").get(args.subtaskId) as { task_id: string }).task_id;
  const request = requestSlotReplacement({
    subtaskId: args.subtaskId,
    taskId,
    roleKey: args.role,
    requestedBy: args.roleAccountId,
    reason: args.reason,
  });

  // Вопрос владельцу: две кнопки, рекомендуемая — первая.
  const payload: QuestionPayload = {
    questions: [
      {
        question: `Слот «${args.role}» завис. Заменить исполнителя свежим агентом той же роли?`,
        header: "Замена слота",
        options: [
          { label: APPROVE_LABEL, description: "Остановить зависшую попытку и запустить свежую той же ролью" },
          { label: REJECT_LABEL, description: "Оставить как есть: роль и Оркестратор разберутся без замены" },
        ],
      },
    ],
    note: args.reason.slice(0, 500),
  };
  const question = createQuestionRow({ chatId: args.chatId, roleId: args.roleAccountId, payload });
  attachQuestion(request.id, question.id);

  const messageId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, reply_to_message_id)
     VALUES (?, ?, ?, 'chat', ?, ?)`,
  ).run(messageId, args.roleAccountId, renderQuestionText(payload), args.chatId, args.messageId);
  db.prepare("UPDATE chat_questions SET message_id = ? WHERE id = ?").run(messageId, question.id);
  db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(args.chatId);
  const members = (db.prepare("SELECT member_id FROM chat_members WHERE chat_id = ?").all(args.chatId) as Array<{ member_id: string }>)
    .map((m) => m.member_id);
  broadcastToUsers(members, { type: "chat:new", message: loadChatMessage(messageId) });

  const answerPromise = waitForAnswer(question.id, { signal: args.signal, timeoutMs: SLOT_REQUEST_TTL_MINUTES * 60_000 });
  broadcastToUsers(members, liveInterruptEvent({ chatId: args.chatId, userId: args.roleAccountId, questionId: question.id, messageId, payload }));
  const answer = await answerPromise;
  broadcastToUsers(members, liveResumeEvent({ chatId: args.chatId, userId: args.roleAccountId, questionId: question.id, outcome: answer ? "answered" : "expired" }));

  if (!answer) {
    // Владелец не ответил — замены нет. Ход не держим: ответ поднимет новый.
    return { status: "open", request: slotReplacementRequest(request.id) ?? request, messageId };
  }

  // Замену применяет маршрут ответа владельца
  // (`/api/chats/:id/questions/:qid/answer`), а не этот ход: две точки,
  // применяющие один ответ, гоняются за один слот. Здесь только ждём, пока
  // заявка перестанет быть pending, и отдаём исход роли.
  const deadline = Date.now() + 10_000;
  let fresh = slotReplacementRequest(request.id) ?? request;
  while (fresh.status === "pending" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    fresh = slotReplacementRequest(request.id) ?? fresh;
  }
  if (fresh.status === "applied") return { status: "applied", request: fresh };
  if (fresh.status === "failed") return { status: "failed", request: fresh, error: fresh.error ?? "замена не удалась" };
  if (fresh.status === "rejected") return { status: "rejected", request: fresh };
  // Заявка ещё pending (маршрут не успел) — не врём роли ни про успех, ни про отказ.
  return { status: "open", request: fresh, messageId };
}

/** Учётка роли по её ключу — нужна для автора вопроса. */
export function accountOfRole(role: string): string {
  return roleUserId(role);
}
