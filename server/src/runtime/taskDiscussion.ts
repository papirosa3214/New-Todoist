// Обсуждение работающей задачи (карточка 252c400e, этапы 3–4 плана).
//
// Что это: отдельная сущность «обсуждение» рядом с работающим этапом.
// Владелец обсуждает с исполнителем, НЕ прерывая его работу:
//   • обсуждение — read-only: все операции записи запрещены в gateway;
//   • рабочая сессия продолжается: обсуждение не берёт аренду слота
//     и не подмешивается в рабочий ход;
//   • промежуточные реплики обсуждения в работу не уходят;
//   • закрытие фиксирует согласованный итог (три раздела) и durable
//     handoff с квитанцией; повторный close не создаёт второго
//     обязательства.
//
// Важное отличие от обычного чата в режиме «Обсуждение»: чатовый режим
// «discussion» (владелец 20.10.2026) — это работа по задаче без
// ограничений, и его политика здесь не меняется. Обсуждение карточки —
// ЯВНО ПОМЕЧЕННЫЙ новый режим «task_discussion» (§5.2 контракта
// архитектора f3ada2e0): только чтение.
//
// Модуль намеренно без сети: всё, что можно проверить, проверяется на
// тестовой SQLite; доставка в работу идёт через существующий путь
// (deliverChatToWork → run.steer), второй рабочий исполнитель не создаётся.

import crypto from "node:crypto";
import db from "../db.js";
import { buildCheckpointSections, type CheckpointSections } from "./chatCheckpoint.js";
import { roleUserId } from "../roleRouting.js";

/** Режим gateway для обсуждения карточки: только чтение. */
export const TASK_DISCUSSION_MODE = "task_discussion";

export type DiscussionState = "open" | "closing" | "closed";
export type DiscussionDeliveryState =
  | "not_ready"
  | "awaiting"
  | "delivered"
  | "failed"
  | "no_recipient";

export interface DiscussionRow {
  discussion_id: string;
  chat_id: string;
  task_id: string;
  subtask_id: string | null;
  role_id: string;
  state: DiscussionState;
  source_run_id: string | null;
  source_leaf_id: string | null;
  source_revision: string | null;
  summary_id: string | null;
  summary_sections_json: string | null;
  handoff_id: string | null;
  delivery_state: DiscussionDeliveryState;
  accepted_at: string | null;
  accepted_by: string | null;
  receipt_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DiscussionHandoffRow {
  handoff_id: string;
  discussion_id: string;
  version: number;
  recipient_subtask_id: string | null;
  recipient_role_id: string | null;
  state: DiscussionDeliveryState;
  payload_json: string;
  receipt_message_id: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface DiscussionCloseResult {
  discussion: DiscussionRow;
  summary: CheckpointSections | null;
  handoff: DiscussionHandoffRow | null;
  delivery: DiscussionDeliveryState;
  /** Повторное закрытие: тот же handoff, новое обязательство не создаётся. */
  repeated: boolean;
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/** Создать обсуждение: своя комната, свой чат, состояние open. */
export function openDiscussion(input: {
  taskId: string;
  subtaskId?: string | null;
  role: string;
  ownerUserId: string;
  title?: string;
  sourceRunId?: string | null;
  sourceLeafId?: string | null;
  sourceRevision?: string | null;
}): { discussion: DiscussionRow; chatId: string } {
  const discussionId = newId("disc");
  const chatId = newId("chat");
  const roleId = roleUserId(input.role);
  const title = input.title?.trim() || `Обсуждение: ${input.taskId}`;
  db.transaction(() => {
    db.prepare(
      "INSERT INTO chats (id,title,kind,created_by,task_id) VALUES (?,?,'group',?,?)",
    ).run(chatId, title, input.ownerUserId, input.taskId);
    db.prepare(
      "INSERT OR IGNORE INTO chat_members (chat_id,member_id) VALUES (?,?)",
    ).run(chatId, input.ownerUserId);
    if (roleId) {
      db.prepare("INSERT OR IGNORE INTO chat_members (chat_id,member_id) VALUES (?,?)").run(chatId, roleId);
    }
    db.prepare(
      `INSERT INTO task_discussions
         (discussion_id,chat_id,task_id,subtask_id,role_id,state,source_run_id,source_leaf_id,source_revision,delivery_state,created_at,updated_at)
       VALUES (?,?,?,?,?,'open',?,?,?,'not_ready',datetime('now'),datetime('now'))`,
    ).run(
      discussionId,
      chatId,
      input.taskId,
      input.subtaskId ?? null,
      roleId ?? input.role,
      input.sourceRunId ?? null,
      input.sourceLeafId ?? null,
      input.sourceRevision ?? null,
    );
  })();
  const discussion = readDiscussion(discussionId)!;
  return { discussion, chatId };
}

export function readDiscussion(discussionId: string): DiscussionRow | null {
  return (
    (db.prepare("SELECT * FROM task_discussions WHERE discussion_id=?").get(discussionId) as
      | DiscussionRow
      | undefined) ?? null
  );
}

export function readHandoff(handoffId: string): DiscussionHandoffRow | null {
  return (
    (db.prepare("SELECT * FROM task_discussion_handoffs WHERE handoff_id=?").get(handoffId) as
      | DiscussionHandoffRow
      | undefined) ?? null
  );
}

/** Это комната обсуждения карточки? Рабочая доставка в неё не идёт. */
export function isDiscussionChat(chatId: string): boolean {
  const row = db.prepare("SELECT 1 FROM task_discussions WHERE chat_id=?").get(chatId);
  return !!row;
}

/** Обсуждение по комнате. */
export function discussionByChatId(chatId: string): DiscussionRow | null {
  return (
    (db.prepare("SELECT * FROM task_discussions WHERE chat_id=?").get(chatId) as
      | DiscussionRow
      | undefined) ?? null
  );
}

/** Открытые обсуждения по задаче. */
export function listDiscussions(taskId: string): DiscussionRow[] {
  return db
    .prepare("SELECT * FROM task_discussions WHERE task_id=? ORDER BY created_at,rowid")
    .all(taskId) as DiscussionRow[];
}

/** Обсуждение может принимать новые реплики только в состоянии open. */
export function acceptsReplies(discussionId: string): boolean {
  return readDiscussion(discussionId)?.state === "open";
}

/**
 * Сообщения обсуждения: владелец и ответы роли.
 * Суммируется ПОЛНЫЙ зафиксированный разговор, а не первые реплики.
 */
export function collectDiscussionMessages(chatId: string): {
  ownerMessages: Array<{ text: string; createdAt?: string }>;
  roleMessages: Array<{ text: string; createdAt?: string; steps?: unknown }>;
} {
  const rows = db
    .prepare(
      `SELECT from_user_id,text,created_at,steps,message_type FROM chat_messages
        WHERE chat_id=? AND channel='chat' ORDER BY rowid ASC`,
    )
    .all(chatId) as Array<{
    from_user_id: string;
    text: string;
    created_at: string;
    steps: string | null;
    message_type: string | null;
  }>;
  const ownerMessages: Array<{ text: string; createdAt?: string }> = [];
  const roleMessages: Array<{ text: string; createdAt?: string; steps?: unknown }> = [];
  for (const row of rows) {
    if (row.message_type === "system" || row.from_user_id === "taskflow_system") continue;
    if (row.from_user_id.startsWith("role_")) {
      roleMessages.push({ text: row.text, createdAt: row.created_at, steps: row.steps ?? undefined });
      continue;
    }
    ownerMessages.push({ text: row.text, createdAt: row.created_at });
  }
  return { ownerMessages, roleMessages };
}

/** Три раздела итога обсуждения — из полного разговора. */
export function buildDiscussionSummary(chatId: string): CheckpointSections {
  const history = collectDiscussionMessages(chatId);
  return buildCheckpointSections({
    ownerMessages: history.ownerMessages,
    roleMessages: history.roleMessages,
  });
}

/**
 * Ключ роли по учётке роли ('role_builder' → 'builder').
 *
 * Путь доставки в работу (deliverChatToWork) ждёт КЛЮЧ роли: он сам
 * превращает его в учётку через roleUserId. Учётка вместо ключа
 * превращалась в 'role_role_builder', слот не находился, и итог
 * обсуждения уходил в no_recipient (дефект D1, карточка 252c400e).
 */
export function roleKeyForUserId(userId: string): string | null {
  const row = db.prepare("SELECT role_key FROM users WHERE id=?").get(userId) as
    | { role_key: string | null }
    | undefined;
  if (row?.role_key) return row.role_key;
  // Запасной путь для учёток без role_key: у ключа роли учётка
  // называется 'role_<ключ>'.
  return userId.startsWith("role_") ? userId.slice("role_".length) : null;
}

/** Кто получатель handoff: исполнитель этапа. */
export function resolveRecipient(input: {
  discussion: DiscussionRow;
  subtaskId?: string | null;
}): { subtaskId: string | null; roleId: string | null; reason: string } {
  const subtaskId = input.subtaskId ?? input.discussion.subtask_id;
  if (!subtaskId) return { subtaskId: null, roleId: null, reason: "не указан этап-получатель" };
  const slot = db
    .prepare("SELECT id,task_id,agent_id,done,agent_state FROM subtasks WHERE id=?")
    .get(subtaskId) as
    | { id: string; task_id: string; agent_id: string | null; done: number; agent_state: string | null }
    | undefined;
  if (!slot) return { subtaskId: null, roleId: null, reason: "этап не найден" };
  if (slot.task_id !== input.discussion.task_id)
    return { subtaskId: null, roleId: null, reason: "этап из другой карточки" };
  if (slot.done) return { subtaskId: null, roleId: null, reason: "этап уже закрыт" };
  if (!slot.agent_id) return { subtaskId: null, roleId: null, reason: "у этапа нет исполнителя" };
  const role = db.prepare("SELECT role_key FROM users WHERE id=?").get(slot.agent_id) as
    | { role_key: string | null }
    | undefined;
  if (!role?.role_key) return { subtaskId: null, roleId: null, reason: "у исполнителя нет роли" };
  return { subtaskId: slot.id, roleId: slot.agent_id, reason: "ok" };
}

export interface CloseOptions {
  discussionId: string;
  /** Кто закрывает (владелец или роль). */
  actorUserId: string;
  /** Получатель handoff; по умолчанию — исполнитель этапа обсуждения. */
  recipientSubtaskId?: string | null;
  /** Ожидание ответа роли, если ход ещё идёт (мс). */
  waitForAnswerMs?: number;
}

/**
 * Закрыть обсуждение.
 *
 * Порядок: граница (closing → новые реплики запрещены) → ожидание
 * текущего ответа → итог по полному разговору → ОДНА транзакция на
 * (итог + handoff) → доставка в работу.
 *
 * Повторный close возвращает тот же handoff и НЕ создаёт второго
 * обязательства: уникальность (discussion_id, version) и проверка
 * уже существующего handoff.
 */
const closingRequests = new Map<string, Promise<DiscussionCloseResult>>();
export function closeDiscussion(options: CloseOptions): Promise<DiscussionCloseResult> {
  const current = closingRequests.get(options.discussionId);
  if (current) return current.then(result => ({...result, repeated: true}));
  const request = closeDiscussionOnce(options);
  closingRequests.set(options.discussionId, request);
  const clear = () => { if (closingRequests.get(options.discussionId) === request) closingRequests.delete(options.discussionId); };
  void request.then(clear, clear);
  return request;
}
async function closeDiscussionOnce(options: CloseOptions): Promise<DiscussionCloseResult> {
  const existing = readDiscussion(options.discussionId);
  if (!existing) throw new Error("Обсуждение не найдено");
  if (existing.state === "closed") {
    const handoff = existing.handoff_id ? readHandoff(existing.handoff_id) : null;
    return {
      discussion: existing,
      summary: parseSummary(existing.summary_sections_json),
      handoff,
      delivery: existing.delivery_state,
      repeated: true,
    };
  }

  // 1. Граница: новые реплики запрещены.
  db.prepare(
    "UPDATE task_discussions SET state='closing',updated_at=datetime('now') WHERE discussion_id=? AND state='open'",
  ).run(options.discussionId);

  // 2. Дождаться текущего ответа роли (если идёт) — иначе итог будет неполным.
  const pending = runningAnswer(options.discussionId);
  if (pending) {
    const limit = options.waitForAnswerMs ?? 30_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("Ответ обсуждения ещё не завершён"), {code: "DISCUSSION_ANSWER_PENDING"})), limit);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  // 3. Итог по полному разговору.
  const summary = buildDiscussionSummary(existing.chat_id);
  const recipient = resolveRecipient({ discussion: existing, subtaskId: options.recipientSubtaskId });
  const summaryId = newId("dsum");

  // 4. Одна транзакция: итог + handoff.
  const handoffId = newId("dhof");
  const version =
    (db
      .prepare("SELECT count(*) n FROM task_discussion_handoffs WHERE discussion_id=?")
      .get(options.discussionId) as { n: number }).n + 1;
  const payload = {
    summary_id: summaryId,
    summary,
    discussion_id: options.discussionId,
    task_id: existing.task_id,
    recipient_subtask_id: recipient.subtaskId,
    recipient_role_id: recipient.roleId,
    created_by: options.actorUserId,
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO task_discussion_handoffs
         (handoff_id,discussion_id,version,recipient_subtask_id,recipient_role_id,state,payload_json,created_at)
       VALUES (?,?,?,?,?,'awaiting',?,datetime('now'))`,
    ).run(
      handoffId,
      options.discussionId,
      version,
      recipient.subtaskId,
      recipient.roleId,
      JSON.stringify(payload),
    );
    db.prepare(
      `UPDATE task_discussions
          SET state='closed',summary_id=?,summary_sections_json=?,handoff_id=?,delivery_state='awaiting',updated_at=datetime('now')
        WHERE discussion_id=?`,
    ).run(summaryId, JSON.stringify(summary), handoffId, options.discussionId);
  })();

  const discussion = readDiscussion(options.discussionId)!;
  const handoff = readHandoff(handoffId)!;
  return { discussion, summary, handoff, delivery: "awaiting", repeated: false };
}

function parseSummary(json: string | null): CheckpointSections | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as CheckpointSections;
  } catch {
    return null;
  }
}

/* ── Текущие ответы роли в обсуждении (для ожидания при закрытии) ─────── */

const runningAnswers = new Map<string, Promise<unknown>>();

/** Зарегистрировать идущий ответ роли — закрытие дождётся его. */
export function trackDiscussionAnswer(discussionId: string, answer: Promise<unknown>): void {
  runningAnswers.set(discussionId, answer);
  const clear = () => {
    if (runningAnswers.get(discussionId) === answer) runningAnswers.delete(discussionId);
  };
  void answer.then(clear, clear);
}

export function runningAnswer(discussionId: string): Promise<unknown> | null {
  return runningAnswers.get(discussionId) ?? null;
}

/* ── Доставка handoff и квитанция ─────────────────────────────────────── */

/**
 * Доставить handoff в работу и зафиксировать состояние доставки.
 *
 * Путь — существующий: deliverChatToWork → run.steer. Второй рабочий
 * исполнитель не создаётся. Квитанция — durable отметка приёма в
 * slot_topic_inbox по (message_id, subtask_id): SDK принял ввод и
 * исполнитель его увидел.
 */
export async function deliverDiscussionHandoff(input: {
  discussionId: string;
  handoffId: string;
  /** Функция доставки в работу; по умолчанию — существующий путь. */
  deliver?: (args: {
    roleId: string;
    chatId: string;
    messageId: string;
    text: string;
    recipientSubtaskId: string;
  }) => Promise<"queued" | "idle" | "busy" | "working">;
  /** Пишет сообщение-итог в ленту обсуждения (для квитанции и для владельца). */
  writeMessage?: (args: {
    chatId: string;
    text: string;
    recipientSubtaskId?: string | null;
  }) => string;
}): Promise<DiscussionDeliveryState> {
  const discussion = readDiscussion(input.discussionId);
  const handoff = readHandoff(input.handoffId);
  if (!discussion || !handoff || handoff.discussion_id !== discussion.discussion_id) return "failed";
  if (handoffReceipt(handoff.handoff_id).received) return handoff.state;
  const recipient = resolveRecipient({discussion, subtaskId: handoff.recipient_subtask_id});
  if (!recipient.subtaskId || recipient.roleId !== handoff.recipient_role_id)
    return setDelivery(input.discussionId, input.handoffId, "no_recipient");
  if (!handoff.recipient_subtask_id || !handoff.recipient_role_id)
    return setDelivery(input.discussionId, input.handoffId, "no_recipient");

  // Адресат доставки — КЛЮЧ роли, не учётка (дефект D1).
  const recipientRoleKey = roleKeyForUserId(handoff.recipient_role_id);
  if (!recipientRoleKey)
    return setDelivery(input.discussionId, input.handoffId, "no_recipient");

  const payload = JSON.parse(handoff.payload_json) as { summary: CheckpointSections };
  const text = renderHandoffText(payload.summary);
  // A durable carrier ID fences retries across process crashes.
  const messageId = handoff.receipt_message_id ?? (input.writeMessage
    ? input.writeMessage({chatId: discussion.chat_id, text, recipientSubtaskId: handoff.recipient_subtask_id})
    : insertDiscussionMessage({
        chatId: discussion.chat_id, fromUserId: discussion.role_id, text,
        recipientSubtaskId: handoff.recipient_subtask_id,
        messageId: "discussion_handoff_" + handoff.handoff_id,
      }));
  db.prepare("UPDATE task_discussion_handoffs SET receipt_message_id=? WHERE handoff_id=?").run(messageId, input.handoffId);

  const deliver =
    input.deliver ??
    (async (args: { roleId: string; chatId: string; messageId: string; text: string; recipientSubtaskId: string }) => {
      const { deliverChatToWork } = await import("./inProcessRun.js");
      return deliverChatToWork(args.roleId, args.chatId, args.messageId, args.text, args.recipientSubtaskId);
    });

  let outcome: "queued" | "idle" | "busy" | "working";
  try {
    outcome = await deliver({
      roleId: recipientRoleKey,
      chatId: discussion.chat_id,
      messageId,
      text,
      recipientSubtaskId: handoff.recipient_subtask_id,
    });
  } catch {
    return setDelivery(input.discussionId, input.handoffId, "failed");
  }
  if (outcome === "idle") return setDelivery(input.discussionId, input.handoffId, "no_recipient");
  if (outcome === "busy") return setDelivery(input.discussionId, input.handoffId, "failed");
  // Ввод принят исполнителем: запоминаем сообщение-носитель — по нему
  // потом проверяется квитанция (отметка приёма в slot_topic_inbox).
  db.prepare("UPDATE task_discussion_handoffs SET receipt_message_id=? WHERE handoff_id=?").run(
    messageId,
    input.handoffId,
  );
  return setDelivery(input.discussionId, input.handoffId, "awaiting");
}

/** Квитанция есть? durable отметка приёма в slot_topic_inbox. */
export function handoffReceipt(handoffId: string): { received: boolean; messageId: string | null } {
  const handoff = readHandoff(handoffId);
  if (!handoff) return { received: false, messageId: null };
  if (!handoff.receipt_message_id) return { received: false, messageId: null };
  const receipt = db
    .prepare("SELECT 1 FROM slot_topic_inbox WHERE message_id=? AND subtask_id=? AND delivered_at IS NOT NULL")
    .get(handoff.receipt_message_id, handoff.recipient_subtask_id);
  return { received: !!receipt, messageId: handoff.receipt_message_id };
}

function setDelivery(
  discussionId: string,
  handoffId: string,
  state: DiscussionDeliveryState,
): DiscussionDeliveryState {
  db.prepare(
    "UPDATE task_discussion_handoffs SET state=?,delivered_at=CASE WHEN ?='delivered' THEN datetime('now') ELSE delivered_at END WHERE handoff_id=?",
  ).run(state, state, handoffId);
  db.prepare(
    "UPDATE task_discussions SET delivery_state=?,updated_at=datetime('now') WHERE discussion_id=?",
  ).run(state, discussionId);
  return state;
}

/**
 * Принять handoff. Без квитанции принятие невозможно: обязательство
 * считается принятым только когда исполнитель его получил.
 */
export function acceptHandoff(input: {
  handoffId: string;
  actorUserId: string;
}): { ok: boolean; reason?: string; discussion?: DiscussionRow } {
  const handoff = readHandoff(input.handoffId);
  if (!handoff) return { ok: false, reason: "Handoff не найден" };
  const discussion = readDiscussion(handoff.discussion_id);
  if (!discussion) return { ok: false, reason: "Обсуждение не найдено" };
  if (discussion.state !== "closed") return { ok: false, reason: "Обсуждение ещё не закрыто" };
  const receipt = handoffReceipt(input.handoffId);
  if (!receipt.received)
    return { ok: false, reason: "Квитанции нет: обязательство ещё не получено исполнителем" };
  setDelivery(discussion.discussion_id, input.handoffId, "delivered");
  db.prepare(
    "UPDATE task_discussions SET accepted_at=datetime('now'),accepted_by=?,updated_at=datetime('now') WHERE discussion_id=?",
  ).run(input.actorUserId, discussion.discussion_id);
  return { ok: true, discussion: readDiscussion(discussion.discussion_id)! };
}

/**
 * Возобновление доставки после падения: handoff со статусом awaiting
 * (записан, но не доставлен) — доставляется заново. Дубля обязательства
 * не создаётся: handoff_id и версия те же.
 */
export async function resumePendingHandoffs(
  deliver?: (args: {
    roleId: string;
    chatId: string;
    messageId: string;
    text: string;
    recipientSubtaskId: string;
  }) => Promise<"queued" | "idle" | "busy" | "working">,
): Promise<number> {
  const pending = db
    .prepare("SELECT handoff_id,discussion_id FROM task_discussion_handoffs WHERE state='awaiting'")
    .all() as Array<{ handoff_id: string; discussion_id: string }>;
  let done = 0;
  for (const row of pending) {
    await deliverDiscussionHandoff({
      discussionId: row.discussion_id,
      handoffId: row.handoff_id,
      deliver,
    });
    done += 1;
  }
  return done;
}

/** Текст handoff: три раздела итога + адресат. */
export function renderHandoffText(summary: CheckpointSections): string {
  return [
    "Итог обсуждения (согласованный):",
    "",
    `1. ${"Что было"}`,
    summary.was,
    "",
    `2. ${"Цель и задача"}`,
    summary.goal,
    "",
    `3. ${"Что выполнить"}`,
    summary.next,
  ].join("\n");
}

/** Сообщение в ленту обсуждения (исполнитель → владелец). */
export function insertDiscussionMessage(input: {
  chatId: string;
  fromUserId: string;
  text: string;
  recipientSubtaskId?: string | null;
  messageId?: string;
}): string {
  const id = input.messageId ?? newId("msg");
  db.prepare(
    `INSERT OR IGNORE INTO chat_messages (id,from_user_id,text,channel,chat_id,recipient_subtask_id)
     VALUES (?,?,?,'chat',?,?)`,
  ).run(id, input.fromUserId, input.text, input.chatId, input.recipientSubtaskId ?? null);
  db.prepare("UPDATE chats SET updated_at=datetime('now') WHERE id=?").run(input.chatId);
  return id;
}
