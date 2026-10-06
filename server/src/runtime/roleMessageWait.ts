/**
 * Срок жизни сообщения роли с вопросом и быстрый отказ при недоступном
 * адресате (MAK-98).
 *
 * Раньше сообщение-вопрос роли уходило коллеге и висело без ответа
 * бесконтрольно: отправитель не узнавал, что ответа не будет. У Гермеса у
 * письма есть срок жизни (15 минут) и быстрый отказ при офлайн-адресате.
 *
 * Здесь:
 *   • `openRoleQuestion` — помнит вопрос роли и его срок (`deadline_at`);
 *   • `answerRoleQuestion` — снимает вопрос, когда в теме появился ответ;
 *   • `expireRoleQuestions` — по сроку возвращает вопрос отправителю
 *     сообщением с исходом «срок истёк»;
 *   • `evaluateRecipientAvailability` — быстрый отказ ДО записи сообщения,
 *     когда адресата некому исполнить (нет роли/шага или шаг закрыт).
 *
 * Порог срока — параметр (`TASKFLOW_ROLE_MESSAGE_TTL_SECONDS`), чтобы его
 * позже вынести в «Настройки → Сервер» (MAK-95), а не хардкод.
 */
import crypto from "node:crypto";
import db from "../db.js";
import { roleUserId } from "../roleRouting.js";
import { logEvent, registryRecord } from "../agentState.js";

/** 15 минут — как у Гермеса, пока не переопределено настройкой сервера. */
export const DEFAULT_ROLE_MESSAGE_TTL_SECONDS = 15 * 60;

export const ROLE_MESSAGE_EXPIRED_OUTCOME = "срок истёк";

const SYSTEM_USER_ID = "taskflow_system";

/** Срок жизни вопроса в секундах: параметр окружения, иначе 15 минут. */
export function roleMessageTtlSeconds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.TASKFLOW_ROLE_MESSAGE_TTL_SECONDS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_ROLE_MESSAGE_TTL_SECONDS;
}

/**
 * Истёк ли срок вопроса. Чистая функция — её проверяют тесты без БД.
 * `createdAt` — время создания в формате SQLite (`YYYY-MM-DD HH:MM:SS`).
 */
export function questionExpired(
  createdAt: string,
  now: Date,
  ttlSeconds: number,
): boolean {
  const created = Date.parse(
    /Z$|[+-]\d{2}:?\d{2}$/.test(createdAt)
      ? createdAt
      : createdAt.replace(" ", "T") + "Z",
  );
  if (Number.isNaN(created)) return false;
  return now.getTime() - created > ttlSeconds * 1000;
}

export type RecipientAvailability =
  | { ok: true }
  | { ok: false; code: "recipient_unavailable"; error: string };

/**
 * Быстрый отказ: может ли адресат вообще ответить. Проверяем ДО записи
 * сообщения, чтобы вопрос не уходил «в пустоту» — отправитель сразу видит
 * код причины. `recipientSubtaskId` — рабочий шаг адресата из плана.
 */
export function evaluateRecipientAvailability(input: {
  recipientSubtaskId: string | null | undefined;
  toUserId?: string | null;
}): RecipientAvailability {
  const slotId = input.recipientSubtaskId;
  if (!slotId) {
    // Явного шага нет — если задан адресат-роль, хватает его учётки.
    if (input.toUserId) {
      const account = db
        .prepare("SELECT 1 FROM users WHERE id = ? AND archived = 0")
        .get(input.toUserId);
      if (!account) {
        return {
          ok: false,
          code: "recipient_unavailable",
          error: "у адресата нет учётной записи — сообщение некому принять",
        };
      }
    }
    return { ok: true };
  }
  const slot = db
    .prepare(
      `SELECT s.id, s.done, s.agent_state, s.plan_node_key, s.collaboration_plan_id,
              n.role_key, n.skipped_at
         FROM subtasks s
         LEFT JOIN task_collaboration_plan_nodes n
           ON n.plan_id = s.collaboration_plan_id AND n.slot_key = s.plan_node_key
        WHERE s.id = ?`,
    )
    .get(slotId) as
    | {
        id: string;
        done: number;
        agent_state: string | null;
        role_key: string | null;
        skipped_at: string | null;
      }
    | undefined;
  if (!slot) {
    return {
      ok: false,
      code: "recipient_unavailable",
      error: "шаг адресата не найден — сообщение некому принять",
    };
  }
  if (slot.done) {
    return {
      ok: false,
      code: "recipient_unavailable",
      error: "шаг адресата уже закрыт — сообщение некому принять",
    };
  }
  if (slot.skipped_at) {
    return {
      ok: false,
      code: "recipient_unavailable",
      error: "шаг адресата пропущен планом — сообщение некому принять",
    };
  }
  if (slot.role_key && !roleUserId(slot.role_key)) {
    return {
      ok: false,
      code: "recipient_unavailable",
      error: `учётка роли «${slot.role_key}» не заведена — сообщение некому принять`,
    };
  }
  return { ok: true };
}

/** Учётка адресата по шагу плана (роль узла) либо явный toUserId. */
export function recipientUserIdFor(
  recipientSubtaskId: string | null | undefined,
  toUserId?: string | null,
): string | null {
  if (toUserId) return toUserId;
  if (!recipientSubtaskId) return null;
  const slot = db
    .prepare(
      `SELECT n.role_key
         FROM subtasks s
         LEFT JOIN task_collaboration_plan_nodes n
           ON n.plan_id = s.collaboration_plan_id AND n.slot_key = s.plan_node_key
        WHERE s.id = ?`,
    )
    .get(recipientSubtaskId) as { role_key: string | null } | undefined;
  if (slot?.role_key) return roleUserId(slot.role_key);
  return null;
}

/** Запомнить вопрос роли с вопросом и сроком ответа. Идемпотентно по id. */
export function openRoleQuestion(input: {
  messageId: string;
  chatId: string;
  taskId?: string | null;
  fromUserId: string;
  toUserId: string;
  subtaskId?: string | null;
  recipientSubtaskId?: string | null;
  text: string;
}): void {
  const ttl = roleMessageTtlSeconds();
  db.prepare(
    `INSERT OR IGNORE INTO role_message_waiting
       (message_id, chat_id, task_id, from_user_id, to_user_id, subtask_id,
        recipient_subtask_id, question_text, deadline_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), 'open')`,
  ).run(
    input.messageId,
    input.chatId,
    input.taskId ?? null,
    input.fromUserId,
    input.toUserId,
    input.subtaskId ?? null,
    input.recipientSubtaskId ?? null,
    input.text.slice(0, 1000),
    `+${ttl} seconds`,
  );
}

/** Снять с учёта открытые вопросы. Точный `replyToMessageId` закрывает
 *  только адресованный вопрос; без него — все открытые вопросы, где этот
 *  пользователь — адресат. */
export function answerRoleQuestionsBy(
  chatId: string,
  answerUserId: string,
  replyToMessageId?: string | null,
): number {
  if (replyToMessageId) {
    return db
      .prepare(
        `UPDATE role_message_waiting
            SET status = 'answered', answered_at = datetime('now')
          WHERE message_id = ? AND status = 'open'`,
      )
      .run(replyToMessageId).changes;
  }
  return db
    .prepare(
      `UPDATE role_message_waiting
          SET status = 'answered', answered_at = datetime('now')
        WHERE chat_id = ? AND to_user_id = ? AND status = 'open'`,
    )
    .run(chatId, answerUserId).changes;
}

/** Вставить сообщение «срок истёк» в тему отправителя вопроса. */
function returnExpiredQuestion(row: {
  message_id: string;
  chat_id: string;
  task_id: string | null;
  from_user_id: string;
  to_user_id: string;
  question_text: string;
}): string {
  const sender = db
    .prepare("SELECT role_key FROM users WHERE id = ?")
    .get(row.from_user_id) as { role_key: string | null } | undefined;
  const mention = sender?.role_key ? `@${sender.role_key} ` : "";
  const text =
    `${mention}${ROLE_MESSAGE_EXPIRED_OUTCOME}: ответа нет за отведённое время. ` +
    `Вопрос был: ${row.question_text.replace(/\s+/g, " ").slice(0, 200)}`;
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO chat_messages
       (id, from_user_id, text, channel, chat_id, task_id, reply_to_message_id, message_type)
     VALUES (?, ?, ?, 'chat', ?, ?, ?, 'system')`,
  ).run(id, SYSTEM_USER_ID, text, row.chat_id, row.task_id, row.message_id);
  return id;
}

/**
 * Вернуть отправителям вопросы, чей срок ответа истёк. Возвращает число
 * обработанных. Вызывается планировщиком (раз в 5 минут), поэтому
 * одиночная неудача не должна валить обход — try/catch на каждом.
 */
export function expireRoleQuestions(now: Date = new Date()): number {
  const ttl = roleMessageTtlSeconds();
  const candidates = db
    .prepare(
      `SELECT message_id, chat_id, task_id, from_user_id, to_user_id,
              question_text, created_at
         FROM role_message_waiting
        WHERE status = 'open'`,
    )
    .all() as Array<{
    message_id: string;
    chat_id: string;
    task_id: string | null;
    from_user_id: string;
    to_user_id: string;
    question_text: string;
    created_at: string;
  }>;
  let expired = 0;
  for (const row of candidates) {
    if (!questionExpired(row.created_at, now, ttl)) continue;
    try {
      const returnId = returnExpiredQuestion(row);
      db.prepare(
        `UPDATE role_message_waiting
            SET status = 'expired', expired_at = datetime('now')
          WHERE message_id = ? AND status = 'open'`,
      ).run(row.message_id);
      if (row.task_id) {
        logEvent({
          taskId: row.task_id,
          actorId: null,
          kind: "role_message_expired",
          field: row.message_id,
          toValue: ROLE_MESSAGE_EXPIRED_OUTCOME,
        });
      }
      registryRecord({
        source: "role_message_waiting",
        trigger: "expireRoleQuestions",
        toUserId: row.from_user_id,
        data: {
          message_id: row.message_id,
          task_id: row.task_id,
          return_message_id: returnId,
        },
        result: "expired",
      });
      expired += 1;
    } catch (error) {
      console.warn(
        `[role-message] срок вопроса ${row.message_id} не обработан:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return expired;
}
