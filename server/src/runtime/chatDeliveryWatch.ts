import crypto from "node:crypto";
import db from "../db.js";
import { recoverAgentDelivery } from "../routes/chats.js";

// Сторож доставок сообщений ролям: два механизма, которые закрывают
// «уточняющий вопрос без ответа».
//
// Владелец 23.10.2026: «если помощник написал коллеге, а коллега задал
// уточняющий вопрос — должен быть ответ». Разбор показал две разные
// дыры, и обе не в «канале» (личные комнаты ролей вечны и открыты), а
// в доставке:
//
//   1. Ход роли УПАЛ (Pi-сбой, таймаут, пустой ответ). Доставка
//      закрывается в `failed`, и больше её никто не поднимает:
//      recovery на старте сервера берёт только `pending`. Вопрос
//      остаётся без ответа навсегда.
//
//   2. Вопрос положен в СЛОТ карточки, а роль по этому слоту не
//      работает (слот закрыт или этап не начат). Доставка лежит в
//      `pending` до TTL (60 минут), после чего сервер закрывает её в
//      `failed` — тихо, без уведомления.
//
// Что здесь делается:
//   • `sweepFailedDeliveries` — поднимает УПАВШИЙ ход заново тем же
//     путём, что и живое сообщение (`recoverAgentDelivery`), с
//     ограниченным числом попыток. Истёкшие по TTL доставки не
//     трогаем: они помечены в payload ключом `expired`.
//   • `sweepStalledDeliveries` — сообщает владельцу, что вопрос
//     висит: роль не работает по этой карточке, а доставка лежит
//     дольше порога. Это последнее окно, когда ещё можно вмешаться.

/** Через сколько минут после сбоя ход поднимается заново. */
export function chatDeliveryRetryMinutes(): number {
  const raw = Number(process.env.TASKFLOW_CHAT_DELIVERY_RETRY_MIN ?? 5);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
}

/** Сколько попыток на одну доставку. Дальше — уведомление владельцу. */
export function chatDeliveryMaxAttempts(): number {
  const raw = Number(process.env.TASKFLOW_CHAT_DELIVERY_MAX_ATTEMPTS ?? 3);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
}

/** Сколько минут вопрос может висеть, прежде чем владельцу уйдёт пинг. */
export function chatDeliveryStallMinutes(): number {
  const raw = Number(process.env.TASKFLOW_CHAT_DELIVERY_STALL_MIN ?? 20);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20;
}

export const DELIVERY_STALLED_NOTICE_TYPE = "delivery_stalled";
export const DELIVERY_RETRY_EXHAUSTED_NOTICE_TYPE = "delivery_retry_exhausted";

interface QueueRow {
  id: string;
  chat_id: string;
  role_id: string;
  message_id: string | null;
  payload_json: string | null;
  finished_at: string | null;
  updated_at: string | null;
  chat_task_id: string | null;
}

function parsePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Уведомление владельцу — тем же способом, что сторожа формата и поиска. */
function notifyOwner(type: string, text: string, taskId: string | null): void {
  const owners = db
    .prepare("SELECT id FROM users WHERE role='owner' AND type='human'")
    .all() as { id: string }[];
  for (const owner of owners) {
    db.prepare(
      "INSERT INTO notifications (id, user_id, type, task_id, text) VALUES (?,?,?,?,?)",
    ).run(crypto.randomUUID(), owner.id, type, taskId, text.slice(0, 400));
  }
}

function alreadyNotified(type: string, text: string, windowMinutes: number): boolean {
  const seen = db
    .prepare(
      "SELECT 1 FROM notifications WHERE type=? AND text=? AND created_at >= datetime('now',?) LIMIT 1",
    )
    .get(type, text, `-${Math.max(1, windowMinutes)} minutes`);
  return Boolean(seen);
}

export interface FailedDeliverySweepReport {
  /** Сколько упавших ходов поднято заново. */
  retried: number;
  /** Сколько доставок исчерпали попытки (уведомление владельцу). */
  exhausted: number;
}

/**
 * Поднять упавшие ходы заново.
 *
 * Берём только `failed`, у которых НЕТ метки `expired` (это доставки,
 * истёкшие по TTL — их сервер закрыл сам, вопрос по ним неактуален).
 * Попытки считаются в `payload_json.retryCount`; лимит достигнут —
 * доставка больше не поднимается, владельцу уходит уведомление.
 */
export async function sweepFailedDeliveries(options?: {
  minAgeMinutes?: number;
  maxAttempts?: number;
  limit?: number;
}): Promise<FailedDeliverySweepReport> {
  const minAge = options?.minAgeMinutes ?? chatDeliveryRetryMinutes();
  const maxAttempts = options?.maxAttempts ?? chatDeliveryMaxAttempts();
  const limit = options?.limit ?? 20;
  const rows = db
    .prepare(
      `SELECT id, chat_id, role_id, message_id, payload_json, finished_at, updated_at, NULL AS chat_task_id
         FROM chat_message_queue
        WHERE status='failed'
          AND finished_at IS NOT NULL
          AND julianday(finished_at) < julianday('now', ?)
          AND COALESCE(json_extract(COALESCE(payload_json,'{}'),'$.expired'),0)=0
        ORDER BY finished_at
        LIMIT ?`,
    )
    .all(`-${Math.max(1, Math.floor(minAge))} minutes`, limit) as QueueRow[];

  const report: FailedDeliverySweepReport = { retried: 0, exhausted: 0 };
  for (const row of rows) {
    const payload = parsePayload(row.payload_json);
    let attempts = Number(payload.retryCount ?? 0);
    if (!Number.isFinite(attempts) || attempts < 0) attempts = 0;
    if (attempts >= maxAttempts) {
      if (!payload.retryExhausted) {
        db.prepare(
          "UPDATE chat_message_queue SET payload_json=json_set(COALESCE(payload_json,'{}'),'$.retryExhausted',1) WHERE id=?",
        ).run(row.id);
        notifyOwner(
          DELIVERY_RETRY_EXHAUSTED_NOTICE_TYPE,
          exhaustedText(row),
          taskIdOfDelivery(row),
        );
        report.exhausted += 1;
      }
      continue;
    }
    // CAS failed → pending: две копии стража не поднимут один ход дважды.
    const claimed = db
      .prepare(
        `UPDATE chat_message_queue
            SET status='pending', picked_at=NULL, finished_at=NULL,
                updated_at=datetime('now'),
                payload_json=json_set(COALESCE(payload_json,'{}'),'$.retryCount',?)
          WHERE id=? AND status='failed'`,
      )
      .run(attempts + 1, row.id);
    if (!claimed.changes) continue;
    try {
      await recoverAgentDelivery({
        chatId: row.chat_id,
        roleId: row.role_id,
        deliveryId: row.id,
      });
      report.retried += 1;
    } catch (error) {
      console.warn(
        `[chatDeliveryWatch] повтор упавшего хода ${row.id} не удался:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return report;
}

/** Карточка, к которой относится доставка (чат карточки или слот в payload). */
function taskIdOfDelivery(row: QueueRow): string | null {
  if (row.chat_task_id) return row.chat_task_id;
  const payload = parsePayload(row.payload_json);
  const subtaskId = typeof payload.subtaskId === "string" ? payload.subtaskId : null;
  if (!subtaskId) return null;
  const subtask = db
    .prepare("SELECT task_id FROM subtasks WHERE id=?")
    .get(subtaskId) as { task_id: string } | undefined;
  return subtask?.task_id ?? null;
}

/** Работает ли роль по этой карточке прямо сейчас. */
function roleWorksOnTask(roleId: string, taskId: string): boolean {
  const slot = db
    .prepare(
      `SELECT 1 FROM subtasks
        WHERE agent_id=? AND task_id=? AND done=0 AND agent_state IN ('in_progress','review')
        LIMIT 1`,
    )
    .get(roleId, taskId);
  if (slot) return true;
  const job = db
    .prepare(
      `SELECT 1 FROM role_run_jobs
        WHERE actor_id=? AND task_id=? AND status IN ('queued','running')
        LIMIT 1`,
    )
    .get(roleId, taskId);
  return Boolean(job);
}

export interface StalledDelivery {
  id: string;
  chatId: string;
  roleId: string;
  taskId: string;
  ageMinutes: number;
  messageId: string | null;
  slot: string | null;
  snippet: string | null;
}

/**
 * Доставки, которые висят: роль-получатель не работает по карточке,
 * а сообщение лежит в `pending` дольше порога. Такие вопросы без
 * вмешательства доживали до TTL и умирали молча.
 */
export function findStalledDeliveries(options?: {
  minAgeMinutes?: number;
  limit?: number;
}): StalledDelivery[] {
  const minAge = options?.minAgeMinutes ?? chatDeliveryStallMinutes();
  const limit = options?.limit ?? 50;
  const rows = db
    .prepare(
      `SELECT q.id, q.chat_id, q.role_id, q.message_id, q.payload_json, q.updated_at,
              c.task_id AS chat_task_id
         FROM chat_message_queue q
         LEFT JOIN chats c ON c.id = q.chat_id
        WHERE q.status='pending'
          AND julianday(q.updated_at) < julianday('now', ?)
        ORDER BY q.updated_at
        LIMIT ?`,
    )
    .all(`-${Math.max(1, Math.floor(minAge))} minutes`, limit) as QueueRow[];

  const stalled: StalledDelivery[] = [];
  for (const row of rows) {
    const taskId = taskIdOfDelivery(row);
    // Вопрос без карточки (личная переписка) ждёт живого хода роли:
    // там доставку поднимает сам маршрут, пинг не нужен.
    if (!taskId) continue;
    if (roleWorksOnTask(row.role_id, taskId)) continue;
    const text = row.message_id
      ? ((db.prepare("SELECT text FROM chat_messages WHERE id=?").get(row.message_id) as
          | { text: string }
          | undefined)?.text ?? null)
      : null;
    const slotMatch = text ? /\[slot:\s*([^\]]+)\]/i.exec(text) : null;
    const ageMinutes = row.updated_at
      ? Math.max(0, Math.floor((Date.now() - Date.parse(`${row.updated_at}Z`)) / 60_000))
      : 0;
    stalled.push({
      id: row.id,
      chatId: row.chat_id,
      roleId: row.role_id,
      taskId,
      ageMinutes,
      messageId: row.message_id,
      slot: slotMatch ? slotMatch[1].trim() : null,
      snippet: text ? text.replace(/\s+/g, " ").slice(0, 160) : null,
    });
  }
  return stalled;
}

function roleName(roleId: string): string {
  const row = db.prepare("SELECT name FROM users WHERE id=?").get(roleId) as
    | { name: string }
    | undefined;
  return row?.name ?? roleId;
}

function taskTitle(taskId: string): string {
  const row = db.prepare("SELECT title FROM tasks WHERE id=?").get(taskId) as
    | { title: string }
    | undefined;
  return row?.title ?? taskId;
}

function stalledText(item: StalledDelivery): string {
  const parts = [
    `Вопрос без ответа: ${roleName(item.roleId)} ждёт ${item.ageMinutes} мин.`,
    `Карточка «${taskTitle(item.taskId)}» (${item.taskId})`,
    item.slot ? `этап ${item.slot}` : null,
    item.snippet ? `Текст: «${item.snippet}»` : null,
    "Роль не работает по этому этапу — либо запусти её, либо ответь сам.",
  ];
  return parts.filter(Boolean).join(". ");
}

function exhaustedText(row: QueueRow): string {
  const payload = parsePayload(row.payload_json);
  const attempts = Number(payload.retryCount ?? 0);
  const taskId = taskIdOfDelivery(row);
  return [
    `Роль не смогла ответить: ход упал ${attempts} раз(а).`,
    `Чат ${row.chat_id}${taskId ? `, карточка ${taskId}` : ""}.`,
    "Вопрос остался без ответа — ответь сам или перезапусти роль.",
  ].join(" ");
}

/**
 * Один проход сторожа висящих вопросов: уведомление владельцу на
 * каждый висящий вопрос (не чаще раза в час на тот же вопрос).
 */
export function sweepStalledDeliveries(options?: {
  minAgeMinutes?: number;
  limit?: number;
  dedupeMinutes?: number;
}): { notified: number; stalled: number } {
  const dedupeMinutes = options?.dedupeMinutes ?? 60;
  const stalled = findStalledDeliveries(options);
  let notified = 0;
  for (const item of stalled) {
    const text = stalledText(item);
    if (alreadyNotified(DELIVERY_STALLED_NOTICE_TYPE, text, dedupeMinutes)) continue;
    notifyOwner(DELIVERY_STALLED_NOTICE_TYPE, text, item.taskId);
    notified += 1;
  }
  return { notified, stalled: stalled.length };
}
