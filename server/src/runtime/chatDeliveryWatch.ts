import { restartDelivery, chatDeliveryMaxRestarts } from "./chatDeliveryRetryBudget.js";
import { dispatchRecoveryRows } from "./chatRecoveryDispatch.js";
import crypto from "node:crypto";
import db from "../db.js";
import { recoverAgentDelivery } from "../routes/chats.js";
import { isChatRoleLocked } from "./chatSession.js";

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
//     трогаем: они помечены в payload ключом `expired`. Сбой старше
//     окна (по умолчанию 6 часов) тоже не трогаем: это не «вопрос без
//     ответа», а archaeology.
//   • `sweepStalledDeliveries` — сообщает владельцу, что вопрос
//     висит: роль не работает по этой карточке (или не занята этой
//     перепиской), а доставка лежит дольше порога. Это последнее
//     окно, когда ещё можно вмешаться.

/** Через сколько минут после сбоя ход поднимается заново. */
export function chatDeliveryRetryMinutes(): number {
  const raw = Number(process.env.TASKFLOW_CHAT_DELIVERY_RETRY_MIN ?? 5);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
}

/** Сколько попыток на одну доставку. Дальше — уведомление владельцу. */
export function chatDeliveryMaxAttempts(): number {
  return chatDeliveryMaxRestarts();
}

/** Сколько минут вопрос может висеть, прежде чем владельцу уйдёт пинг. */
export function chatDeliveryStallMinutes(): number {
  const raw = Number(process.env.TASKFLOW_CHAT_DELIVERY_STALL_MIN ?? 20);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20;
}

/**
 * Как далеко в прошлом может быть сбой хода, чтобы доставку ещё стоило
 * поднимать заново.
 *
 * Без этого ограничения повтор поднимал ВСЕ упавшие доставки: в боевой БД
 * их 75, и 73 из них старше суток (12–21.10.2026). Подъём недельной
 * давности — не починка вопроса, а шум: роль отвечает на вопрос, который
 * уже никому не нужен, и съедает реальный ресурс.
 *
 * Окно 6 часов покрывает живые случаи (ход роли упал ночью — утром
 * владелец ещё ждёт ответа) и отсекает всю archaeology.
 */
export function chatDeliveryRetryMaxAgeMinutes(): number {
  const raw = Number(process.env.TASKFLOW_CHAT_DELIVERY_RETRY_MAX_AGE_MIN ?? 360);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 360;
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
 * истёкшие по TTL — их сервер закрыл сам, вопрос по ним неактуален),
 * и только СВЕЖИЕ сбои: сбой старше окна (по умолчанию 6 часов) не
 * поднимается — это не «вопрос без ответа», а неделя-old archaeology.
 * Попытки считаются в `payload_json.retryCount`; лимит достигнут —
 * доставка больше не поднимается, владельцу уходит уведомление.
 */
export async function sweepFailedDeliveries(options?: {
  minAgeMinutes?: number;
  maxAgeMinutes?: number;
  maxAttempts?: number;
  limit?: number;
}): Promise<FailedDeliverySweepReport> {
  const minAge = options?.minAgeMinutes ?? chatDeliveryRetryMinutes();
  const maxAge = options?.maxAgeMinutes ?? chatDeliveryRetryMaxAgeMinutes();
  const maxAttempts = options?.maxAttempts ?? chatDeliveryMaxAttempts();
  const limit = options?.limit ?? 20;
  const rows = db
    .prepare(
      `SELECT q.id, q.chat_id, q.role_id, q.message_id, q.payload_json, q.finished_at, q.updated_at,
              c.task_id AS chat_task_id
         FROM chat_message_queue q
         LEFT JOIN chats c ON c.id = q.chat_id
        WHERE q.status='failed'
          AND q.finished_at IS NOT NULL
          AND julianday(q.finished_at) < julianday('now', ?)
          AND julianday(q.finished_at) > julianday('now', ?)
          AND COALESCE(json_extract(COALESCE(q.payload_json,'{}'),'$.expired'),0)=0
        ORDER BY q.finished_at
        LIMIT ?`,
    )
    .all(
      `-${Math.max(1, Math.floor(minAge))} minutes`,
      `-${Math.max(1, Math.floor(maxAge))} minutes`,
      limit,
    ) as QueueRow[];

  const report: FailedDeliverySweepReport = { retried: 0, exhausted: 0 };
  await dispatchRecoveryRows(rows, async (row) => {
    const admission = restartDelivery(row.id, "execution_failed", "failed", maxAttempts);
    if (admission === "exhausted") { report.exhausted++; return; }
    if (admission !== "restarted") return;
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
  });
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

/**
 * Живой ли сейчас ход роли.
 *
 * Пока ход идёт, доставку нельзя считать мёртвой: она либо уже взята
 * ролью в работу (`picked`), либо ждёт своей очереди (`pending`), и роль
 * разберёт её, когда освободится. Прежний порог в 60 минут в этом случае
 * помечал неуспешным сообщение легитимного долгого хода роли — замечание
 * проверяющей к правке d2789497.
 *
 * Признаки живого хода:
 *   • роль заняла пару (чат, роль) — ход роли идёт прямо сейчас;
 *   • у роли есть живая попытка с недавним пульсом;
 *   • у роли есть занятый слот карточки с недавним пульсом.
 *
 * Живёт здесь, а не в `chatQueueRecovery.ts`: тем же признанием живого
 * хода пользуется и сторож висящих вопросов, и просрочка доставок —
 * одно понятие «роль занята» на оба случая.
 */
export function roleIsBusyNow(roleId: string, chatId: string): boolean {
  if (chatId && isChatRoleLocked(chatId, roleId)) return true;
  const attempt = db
    .prepare(
      `SELECT 1 FROM attempts
        WHERE executor_id = ? AND ended_at IS NULL
          AND heartbeat_at > datetime('now', '-10 minutes')
        LIMIT 1`,
    )
    .get(roleId);
  if (attempt) return true;
  const slot = db
    .prepare(
      `SELECT 1 FROM subtasks
        WHERE agent_id = ? AND done = 0
          AND agent_state IN ('in_progress', 'review')
          AND agent_heartbeat_at > datetime('now', '-10 minutes')
        LIMIT 1`,
    )
    .get(roleId);
  return Boolean(slot);
}

export interface StalledDelivery {
  id: string;
  chatId: string;
  roleId: string;
  /** Карточка доставки; в личной переписке её нет — null. */
  taskId: string | null;
  ageMinutes: number;
  messageId: string | null;
  slot: string | null;
  snippet: string | null;
}

/**
 * Доставки, которые висят: роль-получатель не работает по карточке
 * (или не занята этой перепиской), а сообщение лежит в `pending` дольше
 * порога. Такие вопросы без вмешательства доживали до TTL и умирали
 * молча.
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
    if (taskId) {
      // Карточка: роль работает по ней — вопрос в очереди, всё в порядке.
      if (roleWorksOnTask(row.role_id, taskId)) continue;
    } else {
      // Личная переписка: карточки нет, но вопрос висит так же — если
      // роль им не занята. Это ровно тот случай, о котором владелец
      // 23.10.2026: «регистратор задал уточняющий вопрос — и никто не
      // ответит». Раньше такие доставки молча пропускались.
      if (roleIsBusyNow(row.role_id, row.chat_id)) continue;
    }
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
    item.taskId
      ? `Карточка «${taskTitle(item.taskId)}» (${item.taskId})`
      : `Переписка ${item.chatId}`,
    item.slot ? `этап ${item.slot}` : null,
    item.snippet ? `Текст: «${item.snippet}»` : null,
    item.taskId
      ? "Роль не работает по этому этапу — либо запусти её, либо ответь сам."
      : "Роль не занята этой перепиской — ответь в чате сам или запусти роль.",
  ];
  return parts.filter(Boolean).join(". ");
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
