import {ensureCoordinationCard,coordinationDeliveryChanged,traceCoordination} from "./chatCoordination.js";
// Durable очередь ходов роли в чате и generation fence.
//
// До этого модуля очередь ответов жила in-memory в chatSession.ts:
// `chatRoleQueues` (Map) и `chatRoleLocks` (Set) — оба сбрасываются при
// рестарте процесса. После рестарта неотвеченные ходы исчезали: юзер
// видел «отправил», а ответа не приходило до следующего сообщения.
//
// Карточка ebc4d338 (queue, 09.10.2026) фиксирует четыре требования,
// которые не закрываются памятью процесса:
//   1. Второе сообщение во время активного хода не теряется — оба
//      обещаны ответом, в том порядке, в котором отправлены.
//   2. Рестарт сервера между сообщением и ответом не съедает ход:
//      следующий старт in-process worker сам подберёт pending.
//   3. Повторная доставка (сеть, retry POST) распознаётся по
//      `delivery_id` и не создаёт дубль.
//   4. Смена поколения сессии (`/new-session`, крэш Pi) отсекает
//      поздние ответы старого runа — `superseded`-запись вместо лжи.
//
// Структура и инварианты:
//
//   chat_message_queue(chat_id, role_id, delivery_id) — UNIQUE.
//     Один и тот же delivery_id на пару (chat, role) — это
//     идемпотентный повтор; ON CONFLICT мы возвращаем старый `id`,
//     без дубля, без второго хода.
//
//   chat_session_generation(chat_id, role_id) → generation.
//     BumpGeneration инкрементирует и помечает старые pending ходы
//     `superseded`. Ход, пришедший со старым generation (запоздалый
//     ответ старого runа), при apply получает fence и помечает
//     `superseded`, не прорастая в новый ответ.
//
// Каркас вокруг in-memory очереди chatSession.ts остаётся: она
// продолжает сериализовать активные ходы. durable таблица — это
// подложка: persistent log и dedupe. Применение (выполнение fn)
// происходит как и раньше, через существующий `enqueueChatReply`,
// но теперь поверх durable write.
//
// Серилизация в этой таблице — только обязательства: «ход записан».
// Реальную обработку ведёт существующий `enqueueChatReply`. Поэтому
// `enqueueMessageDelivery` НЕ запускает Pi-сессию. Это отдельный шаг:
// in-memory очередь берёт ход в работу через claim/picked_at/finished.

import crypto from "node:crypto";
import db from "../db.js";

export type DeliveryStatus =
  | "pending"
  | "picked"
  | "done"
  | "failed"
  | "superseded";

export interface MessageDelivery {
  id: string;
  chat_id: string;
  role_id: string;
  delivery_id: string;
  message_id: string | null;
  session_generation: number;
  payload_json: string;
  status: DeliveryStatus;
  picked_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueInput {
  chatId: string;
  roleId: string;
  /** Уникальный в пределах пары (chat, role). По умолчанию — message_id. */
  deliveryId: string;
  /** Текст сообщения для следующего хода сессии; сериализуется JSON. */
  payload: unknown;
  /** FK в chat_messages, если ход привязан к конкретному сообщению. */
  messageId?: string | null;
  /** Generation на момент принятия. Если null — берётся текущий. */
  sessionGeneration?: number;
}

export interface EnqueueResult {
  id: string;
  created: boolean;
  generation: number;
}

const uid = () => `cmq_${crypto.randomUUID()}`;

/** Прочитать generation пары (chat, role) или 1, если строки ещё нет.
 *  Номера generation растут от 1: первое сообщение пары получает
 *  generation=1, бамп даёт 2 и т.д. Семантически `generation=0`
 *  используется только в коде как «нет записи», в БД она не
 *  сохраняется. */
function readGeneration(chatId: string, roleId: string): number {
  const row = db
    .prepare(
      "SELECT generation FROM chat_session_generation WHERE chat_id=? AND role_id=?",
    )
    .get(chatId, roleId) as { generation: number } | undefined;
  return row?.generation ?? 1;
}

/** Активный generation пары (chat, role). Вспомогательная — для
 *  тех, кому не нужен записанный ход, а только актуальный номер. */
export function currentChatGeneration(chatId: string, roleId: string): number {
  return readGeneration(chatId, roleId);
}

/**
 * Идемпотентно записать pending-холд на (chat, role). Один и тот же
 * `deliveryId` на эту пару НЕ создаёт дубль — мы возвращаем уже
 * записанный `id` и `created=false`.
 *
 * Семантика generation: если карточка не передала `sessionGeneration`,
 * берётся текущий. Это значит, что:
 *   - нормальный путь сообщения → `sessionGeneration = current`;
 *   - ход из старой сессии, прилетевший по сети ПОСЛЕ `/new` →
 *     карточка явно передаёт старый номер, и apply отбросит его.
 */
export function enqueueMessageDelivery(input: EnqueueInput): EnqueueResult {
  const generation = input.sessionGeneration ?? readGeneration(input.chatId, input.roleId);
  const payloadJson = JSON.stringify(input.payload ?? null);
  const id = uid();
  // ON CONFLICT возвращаем уже существующий id (created=false) — у нас
  // нет обновления payload при повторе: текст сообщения уже записан
  // в chat_messages, и если сеть повторила POST, мы просто отвечаем
  // тот же ид.
  const inserted = db
    .prepare(
      `INSERT INTO chat_message_queue
         (id, chat_id, role_id, delivery_id, message_id, session_generation, payload_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(chat_id, role_id, delivery_id) DO NOTHING`,
    )
    .run(
      id,
      input.chatId,
      input.roleId,
      input.deliveryId,
      input.messageId ?? null,
      generation,
      payloadJson,
    );
  if (inserted.changes > 0) {
    if(input.messageId)traceCoordination(()=>ensureCoordinationCard(input.messageId!,input.roleId));
    return { id, created: true, generation };
  }
  const row = db
    .prepare(
      `SELECT id, session_generation FROM chat_message_queue
        WHERE chat_id=? AND role_id=? AND delivery_id=?`,
    )
    .get(input.chatId, input.roleId, input.deliveryId) as
    | { id: string; session_generation: number }
    | undefined;
  return {
    id: row?.id ?? id,
    created: false,
    generation: row?.session_generation ?? generation,
  };
}

/** Получить pending-холды для пары (chat, role) по возрастанию
 *  `created_at` — это порядок, в котором in-memory очередь должна их
 *  исполнить. */
export function pendingMessageDeliveries(input: {
  chatId: string;
  roleId: string;
  limit?: number;
}): MessageDelivery[] {
  const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 10)));
  return db
    .prepare(
      `SELECT * FROM chat_message_queue
        WHERE chat_id=? AND role_id=? AND status='pending'
        ORDER BY created_at, rowid
        LIMIT ?`,
    )
    .all(input.chatId, input.roleId, limit) as MessageDelivery[];
}

/** Получить `pending` ходы вообще (для recovery после рестарта). Без
 *  привязки к chat — выбираем всё, что не доехало, в порядке
 *  `created_at`. Это то, что in-memory очередь потеряла при рестарте. */
export function allPendingDeliveries(limit?: number): MessageDelivery[] {
  const cap = Math.min(200, Math.max(1, Math.floor(limit ?? 50)));
  return db
    .prepare(
      `SELECT * FROM chat_message_queue
        WHERE status='pending'
        ORDER BY created_at, rowid
        LIMIT ?`,
    )
    .all(cap) as MessageDelivery[];
}

/** Получить `pending` ходы конкретной generation на паре — для
 *  fence-check: при bump мы знаем, что нужно похерить. */
export function pendingDeliveriesByGeneration(input: {
  chatId: string;
  roleId: string;
  generation: number;
}): MessageDelivery[] {
  return db
    .prepare(
      `SELECT * FROM chat_message_queue
        WHERE chat_id=? AND role_id=? AND status='pending' AND session_generation=?`,
    )
    .all(input.chatId, input.roleId, input.generation) as MessageDelivery[];
}

/** Атомарно пометить ход `picked` (взят в работу). Это не fence,
 *  только синхронизация: один pickup на ход. */
export function claimMessageDelivery(id: string): boolean {
  const changed = (
    db
      .prepare(
        `UPDATE chat_message_queue
            SET status='picked', picked_at=datetime('now'), updated_at=datetime('now')
          WHERE id=? AND status='pending'`,
      )
      .run(id).changes === 1
  );
  if(changed)traceCoordination(()=>coordinationDeliveryChanged(id));
  return changed;
}

/** Завершить ход: `done` или `failed`. Ход, чьё generation уже не
 *  текущий, нельзя закрыть как `done` — это fence. Такие переводятся
 *  в `superseded` через `fenceMessageDelivery`. */
export function finishMessageDelivery(id: string, ok: boolean): boolean {
  const status = ok ? "done" : "failed";
  const changed = (
    db
      .prepare(
        `UPDATE chat_message_queue
            SET status=?, finished_at=datetime('now'), updated_at=datetime('now')
          WHERE id=? AND status='picked'`,
      )
      .run(status, id).changes === 1
  );
  if(changed)traceCoordination(()=>coordinationDeliveryChanged(id));
  return changed;
}

/** Применить fence: пометить ход `superseded` независимо от того,
 *  был ли он `pending` или уже `picked`. Используется, когда
 *  обнаружено, что generation устарел. */
export function fenceMessageDelivery(id: string): boolean {
  const changed = (
    db
      .prepare(
        `UPDATE chat_message_queue
            SET status='superseded', finished_at=datetime('now'), updated_at=datetime('now')
          WHERE id=? AND status IN ('pending','picked')`,
      )
      .run(id).changes === 1
  );
  if(changed)traceCoordination(()=>coordinationDeliveryChanged(id));
  return changed;
}

/** Инкремент generation пары. Все ходы старой generation, что ещё
 *  висят в `pending`, переводятся в `superseded` — это и есть fence
 *  при `/new-session` или фактическом рестарте.
 *
 *  Возвращает свежий generation. Вызывающий код использует его,
 *  чтобы убедиться, что ВСЕ сообщения, отправленные ДО bump,
 *  получат fence. Сообщение, отправленное ПОСЛЕ bump, попадает на
 *  новый generation — это нормальный путь. */
export function bumpChatGeneration(input: {
  chatId: string;
  roleId: string;
  reason: string;
}): { generation: number; superseded: number } {
  const reason = (input.reason ?? "").slice(0, 200);
  const prev = readGeneration(input.chatId, input.roleId);
  const next = prev + 1;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO chat_session_generation(chat_id, role_id, generation, bumped_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(chat_id, role_id) DO UPDATE SET
           generation=excluded.generation,
           bumped_at=excluded.bumped_at`,
    ).run(input.chatId, input.roleId, next);
    // Fence старых pending. Ходы с generation < next уходят в
    // superseded — без лжи «уже обработано», с честной отметкой
    // о причине.
    const oldPending = db
      .prepare(
        `SELECT id FROM chat_message_queue
          WHERE chat_id=? AND role_id=? AND status='pending' AND session_generation < ?`,
      )
      .all(input.chatId, input.roleId, next) as Array<{ id: string }>;
    if (oldPending.length) {
      const upd = db.prepare(
        `UPDATE chat_message_queue
            SET status='superseded', finished_at=datetime('now'),
                updated_at=datetime('now')
          WHERE id=? AND status='pending'`,
      );
      for (const row of oldPending) upd.run(row.id);
    }
    // История бампа — в task_events, чтобы UI и агенты видели смену
    // поколения в одной ленте с обычными событиями карточки.
    const chat = db
      .prepare("SELECT task_id FROM chats WHERE id=?")
      .get(input.chatId) as { task_id: string | null } | undefined;
    if (chat?.task_id) {
      db.prepare(
        `INSERT INTO task_events(task_id, actor_id, kind, field, from_value, to_value)
           VALUES (?, NULL, 'chat_session_bump', ?, ?, ?)`,
      ).run(
        chat.task_id,
        `${input.roleId}:${input.chatId}`,
        `gen=${prev}`,
        `gen=${next}; reason=${reason}`,
      );
    }
    return oldPending.length;
  });
  const superseded = tx();
  return { generation: next, superseded };
}

/** Прочитать доставку по `id` (для recovery-sweep). */
export function getMessageDelivery(id: string): MessageDelivery | undefined {
  return db
    .prepare(
      `SELECT * FROM chat_message_queue WHERE id = ?`,
    )
    .get(id) as MessageDelivery | undefined;
}

/** Generation, зафиксированный в `chat_message_queue.session_generation`
 *  для конкретного хода. Это то поколение, на котором ход был принят;
 *  его нельзя «освежить» — оно фиксируется на момент enqueue. */
export function deliverySessionGeneration(id: string): number | null {
  const row = db
    .prepare(
      `SELECT session_generation FROM chat_message_queue WHERE id = ?`,
    )
    .get(id) as { session_generation: number } | undefined;
  return row?.session_generation ?? null;
}

/** Тестовая утилита. В проде не нужна — задача живёт в БД. */
export function _resetChatQueueForTests(): void {
  db.prepare("DELETE FROM chat_message_queue").run();
  db.prepare("DELETE FROM chat_session_generation").run();
}
