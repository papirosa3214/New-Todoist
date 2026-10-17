// Карточка 7efcc173, слот implement. Серверная строка прогресса в теме
// задачи: «Карточка» — Роль · шаг — начал/сдал/заблокирован/доработка.
//
// Контракт — заметка 73bf5e8d (Архитектор, слот locate):
//  — писать в ТЕМУ задачи (`chats WHERE task_id=? AND parent_chat_id IS NOT
//    NULL`), общий чат и личные чаты ролей не трогаем;
//  — ровно ОДНО сообщение на смену состояния и ноль повторов после
//    перезапуска. Обе гарантии даёт таблица `step_topic_progress`
//    (миграция 151): `INSERT OR IGNORE` по (subtask_id, notice_key) идёт
//    ДО записи в чат, поэтому повторный вызов того же перехода, тик
//    сторожа и два процесса подряд дают максимум одно сообщение;
//  — `notice_key` = `<notice>:<admission_cycle>` (+ `blocked_at` у блока),
//    а `admission_cycle` растёт на каждом допуске шага, поэтому доработка
//    открывает новый цикл и «начал» проходит снова, но повтор старого
//    цикла — нет;
//  — шаги без плана, ручные карточки и закрытые темы не пишут ничего;
//  — ошибка сообщения не должна ронять приёмку шага: весь вызов под
//    try/catch + console.warn.
//
// В `slot_topic_inbox` ничего не пишем: это сообщение для владельца,
// будить им роль не нужно.

import crypto from "node:crypto";
import db from "../db.js";
import { ensurePlanTopic, isTaskTopicClosed } from "../lib/projectTopics.js";
import { loadChatMessage } from "../lib/chatMessages.js";
import { roleTitle } from "../roleRouting.js";

const SYSTEM_USER_ID = "taskflow_system";

export type StepNotice = "started" | "submitted" | "blocked" | "returned";

const NOTICE_WORD: Record<StepNotice, string> = {
  started: "начал",
  submitted: "сдал",
  blocked: "заблокирован",
  returned: "вернулся на доработку",
};

const MAX_TASK_CHARS = 60;
const MAX_STEP_CHARS = 80;
const MAX_REASON_CHARS = 120;

type StepRow = {
  id: string;
  task_id: string;
  title: string;
  agent_id: string | null;
  collaboration_plan_id: string | null;
  plan_node_key: string | null;
  admission_cycle: number | null;
  blocked_at: string | null;
};

/** Обрезка по словам: многоточие не должно рвать слово пополам. */
function clip(text: string, max: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/** Роль шага: узел плана — основной источник, `agent_id` — запасной. */
function roleOf(step: StepRow): string {
  const node = step.collaboration_plan_id
    ? (db
        .prepare(
          "SELECT role_key FROM task_collaboration_plan_nodes WHERE plan_id=? AND slot_key=?",
        )
        .get(step.collaboration_plan_id, step.plan_node_key ?? "") as
        | { role_key: string }
        | undefined)
    : undefined;
  if (node?.role_key) return roleTitle(node.role_key);
  const user = step.agent_id
    ? (db.prepare("SELECT role_key, role FROM users WHERE id=?").get(step.agent_id) as
        | { role_key: string | null; role: string | null }
        | undefined)
    : undefined;
  if (user?.role_key) return roleTitle(user.role_key);
  return user?.role || "Роль";
}

function noticeKey(step: StepRow, notice: StepNotice): string {
  const base = `${notice}:${step.admission_cycle ?? 0}`;
  // Два разных блока внутри одного цикла — разные ключи, один и тот же
  // блок, повторённый сторожем, — один ключ.
  return notice === "blocked" && step.blocked_at ? `${base}:${step.blocked_at}` : base;
}

function buildText(step: StepRow, taskTitle: string | null, notice: StepNotice, reason?: string | null): string {
  const head =
    `«${clip(taskTitle || "Без названия", MAX_TASK_CHARS)}»` +
    ` — ${roleOf(step)} · ${clip(step.title, MAX_STEP_CHARS)}` +
    ` — ${NOTICE_WORD[notice]}`;
  const tail = clip(reason ?? "", MAX_REASON_CHARS);
  return notice === "blocked" && tail ? `${head} — ${tail}` : head;
}

/**
 * Живое обновление без перезагрузки. Рассылку делаем в микрозадаче: если
 * вызов случился внутри транзакции, к этому моменту она уже закоммичена
 * (better-sqlite3 синхронный). Откат транзакции гасит рассылку проверкой
 * «сообщение существует» — пузыря несуществующей строки клиент не получит.
 */
function pushToTopic(chatId: string, messageId: string): void {
  queueMicrotask(() => {
    void (async () => {
      try {
        const message = loadChatMessage(messageId);
        if (!message) return;
        const members = (
          db.prepare("SELECT member_id FROM chat_members WHERE chat_id=?").all(chatId) as Array<{
            member_id: string;
          }>
        ).map((r) => r.member_id);
        const { broadcastToUsers } = await import("../ws.js");
        broadcastToUsers(members, { type: "chat:new", message });
      } catch (error) {
        console.warn(`[stepTopicProgress] рассылка ${messageId} в тему не ушла:`, error);
      }
    })();
  });
}

function announce(subtaskId: string, notice: StepNotice, reason?: string | null): string | null {
  const step = db
    .prepare(
      `SELECT id, task_id, title, agent_id, collaboration_plan_id, plan_node_key,
              admission_cycle, blocked_at
         FROM subtasks WHERE id=?`,
    )
    .get(subtaskId) as StepRow | undefined;
  // Шаги без плана и ручные карточки в прогресс не попадают.
  if (!step?.collaboration_plan_id) return null;
  const plan = db
    .prepare("SELECT status FROM task_collaboration_plans WHERE id=?")
    .get(step.collaboration_plan_id) as { status: string } | undefined;
  if (plan?.status !== "approved") return null;
  if (isTaskTopicClosed(step.task_id)) return null;

  let topicId = (
    db
      .prepare("SELECT id FROM chats WHERE task_id=? AND parent_chat_id IS NOT NULL")
      .get(step.task_id) as { id: string } | undefined
  )?.id;
  if (!topicId) {
    try {
      topicId = ensurePlanTopic(step.task_id) ?? undefined;
    } catch (error) {
      console.warn(`[stepTopicProgress] тему задачи ${step.task_id} создать не удалось:`, error);
    }
    if (!topicId) return null;
  }

  const key = noticeKey(step, notice);
  const claimed = db
    .prepare(
      "INSERT OR IGNORE INTO step_topic_progress (subtask_id, notice_key, created_at) VALUES (?, ?, datetime('now'))",
    )
    .run(step.id, key);
  if (claimed.changes === 0) return null;

  const taskTitle = (
    db.prepare("SELECT title FROM tasks WHERE id=?").get(step.task_id) as { title: string } | undefined
  )?.title;
  const text = buildText(step, taskTitle ?? null, notice, reason);
  const messageId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, task_id, message_type, subtask_id)
     VALUES (?, ?, ?, 'chat', ?, ?, 'system', ?)`,
  ).run(messageId, SYSTEM_USER_ID, text, topicId, step.task_id, step.id);
  db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id=?").run(topicId);
  db.prepare("UPDATE step_topic_progress SET message_id=? WHERE subtask_id=? AND notice_key=?").run(
    messageId,
    step.id,
    key,
  );
  pushToTopic(topicId, messageId);
  return messageId;
}

/**
 * Одна строка прогресса о шаге плана в теме задачи. Возвращает id
 * сообщения или null (нечего писать / уже писали / не получилось).
 * Никогда не бросает: сдача шага не должна зависеть от сообщения в чат.
 */
export function announceStepState(
  subtaskId: string,
  notice: StepNotice,
  reason?: string | null,
): string | null {
  try {
    return announce(subtaskId, notice, reason);
  } catch (error) {
    console.warn(`[stepTopicProgress] сообщение о шаге ${subtaskId} не отправилось:`, error);
    return null;
  }
}