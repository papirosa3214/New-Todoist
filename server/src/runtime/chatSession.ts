// Карточка ebc4d338 (queue, 09.10.2026): подложим под in-memory
// очередь durable лог в chat_message_queue. Хелпер ниже даёт
// минимальный интерфейс записи, которую зовёт существующая
// очередь enqueueChatReply. ВАЖНО: этот модуль — единственное место,
// где in-memory очередь обязана синхронизироваться с БД. Остальные
// модули (routes/chats.ts, runtime/inProcessRun.ts) могут писать в
// durable таблицу сами, когда им нужен только учёт без запуска Pi.
import {
  enqueueMessageDelivery as durableEnqueue,
  claimMessageDelivery,
  finishMessageDelivery,
  fenceMessageDelivery,
  pendingMessageDeliveries,
  startDeliveryHeartbeat,
  failPendingMessageDelivery,
  bumpChatGeneration,
  type MessageDelivery,
} from "./chatQueue.js";
import { currentChatGeneration } from "./chatQueue.js";
import { markChatItemBlockedByServer } from "../lib/subtaskWorkPlan.js";
import { logEvent } from "../agentState.js";

// Хранилище живых онлайн-сессий Пи: одна строка на (чат, роль).
//
// Назначение: на чате может быть несколько ролей-участниц; каждая держит
// собственный сеанс Пи с собственным sessionId. Контекст сохраняется между
// сообщениями именно потому, что мы возвращаем тот же sessionId обратно в
// адаптер (см. startChatRun в PiRuntimeAdapter). Без таблицы каждый ход
// начинался бы заново, и онлайн-разговор стал бы похож на «общение с
// амнезией».
//
// Изоляция: это ЕДИНСТВЕННОЕ постоянное место состояния онлайн-чата. Ни в
// tasks, ни в attempts, ни в agent_state, ни в аренде строка не пишется и
// оттуда не читается — чат живёт отдельной осью, и снять/поломать карточку
// через чат невозможно. FK на chats и users сделаны каскадными, чтобы
// удаление чата или участника само убирало и сессии; ни на tasks, ни на
// attempts ссылок нет и не должно появиться.
//
// Слой выбран прикладной (не «репозиторий» с интерфейсом): таблица одна,
// SQL тривиальный, мокать ради тестов нечего. Если таблиц станет больше —
// выделим в отдельный слой.

import db from "../db.js";

const uid = () => crypto.randomUUID();


interface ChatSessionRow {
  chat_id: string;
  role_id: string;
  pi_session_id: string;
  updated_at: string;
}

/** Прочитать сохранённый sessionId для (chat, role) или null, если ещё нет.
 *
 *  null — нормальный ответ для первого сообщения в чате: это не ошибка, а
 *  приглашение поднять новую сессию через startChatRun. */
export function getChatSessionId(chatId: string, roleId: string): string | null {
  const row = db
    .prepare(
      "SELECT pi_session_id FROM chat_sessions WHERE chat_id = ? AND role_id = ?",
    )
    .get(chatId, roleId) as { pi_session_id: string } | undefined;
  return row?.pi_session_id ?? null;
}

/** Полная строка сессии (chat_id, role_id, sessionId, updated_at) или null,
 *  если её ещё нет. Используется в тестах и при отладке. */
export function getChatSession(
  chatId: string,
  roleId: string,
): ChatSessionRow | null {
  const row = db
    .prepare(
      "SELECT chat_id, role_id, pi_session_id, updated_at FROM chat_sessions " +
        "WHERE chat_id = ? AND role_id = ?",
    )
    .get(chatId, roleId) as ChatSessionRow | undefined;
  return row ?? null;
}

/** Апсёрт sessionId по составному ключу. ON CONFLICT обновляет и sessionId,
 *  и updated_at: продолжаем ту же сессию — обновляем «последний раз видели»;
 *  переезжаем на новую (например, после падения старой) — пишем новый id и
 *  тоже поднимаем updated_at, чтобы админ мог видеть свежесть. */
export function upsertChatSession(chatId: string, roleId: string, piSessionId: string): void {
  db.prepare(
    "INSERT INTO chat_sessions (chat_id, role_id, pi_session_id, updated_at) " +
      "VALUES (?, ?, ?, datetime('now')) " +
      "ON CONFLICT(chat_id, role_id) DO UPDATE SET " +
      "pi_session_id = excluded.pi_session_id, updated_at = datetime('now')",
  ).run(chatId, roleId, piSessionId);
}

/** Снять сессию для пары (chat, role). Используется при отмене и при
 *  явной команде «забыть разговор»: после удаления следующее сообщение
 *  начнёт новую сессию. */
export function clearChatSession(chatId: string, roleId: string): void {
  db.prepare(
    "DELETE FROM chat_sessions WHERE chat_id = ? AND role_id = ?",
  ).run(chatId, roleId);
}

/** Список участников чата, у которых уже есть активная онлайн-сессия.
 *  Используется в админке/UI («где идёт разговор прямо сейчас»). */
export function listChatSessionsByChat(chatId: string): ChatSessionRow[] {
  return db
    .prepare(
      "SELECT chat_id, role_id, pi_session_id, updated_at FROM chat_sessions " +
        "WHERE chat_id = ? ORDER BY updated_at DESC",
    )
    .all(chatId) as ChatSessionRow[];
}

/** Служебная функция: новый runId для онлайн-сессии. Отдельный префикс от
 *  taskId-рантайма (`chat_`), чтобы в логах и в тестах сразу видно было
 *  происхождение захода и чтобы случайное столкновение id было
 *  невозможно по построению. */
export function makeChatRunId(): string {
  return `chat_${uid()}`;
}

/** Активные онлайн-сессии в памяти процесса. Источник правды — таблица
 *  chat_sessions, эта карта — только рантайм-лок, чтобы не словить гонку
 *  «два сообщения подряд на одну пару». После рестарта процесса карта
 *  пуста, и сервер по таблице поднимет сессии по сохранённым sessionId —
 *  теряется только «кто сейчас в полёте», а не «у кого какой контекст». */
const chatRoleLocks = new Set<string>();

/** Занят ли прямо сейчас слот (chat, role)? Используется в гейтах чат-роута
 *  и в тестах. */
export function isChatRoleLocked(chatId: string, roleId: string): boolean {
  return chatRoleLocks.has(`${chatId}:${roleId}`);
}

/** Захватить слот. Возвращает true при успехе, false если уже занят. */
export function acquireChatRoleLock(chatId: string, roleId: string): boolean {
  const key = `${chatId}:${roleId}`;
  if (chatRoleLocks.has(key)) return false;
  chatRoleLocks.add(key);
  return true;
}

/** Освободить слот. Безопасно звать повторно — лишний release не падает. */
export function releaseChatRoleLock(chatId: string, roleId: string): void {
  chatRoleLocks.delete(`${chatId}:${roleId}`);
}

/** Тестовая утилита: сбросить все in-memory локи. В проде не нужна — после
 *  рестарта процесса карта и так пуста. */
export function _resetChatRoleLocksForTests(): void {
  chatRoleLocks.clear();
}

// ===== Очередь ответов на (chat, role) =====
//
// Гермес (B5, замечание от 21.09.2026): без сериализации два быстрых
// сообщения подряд на одну роль в одном чате могут выполниться
// ПАРАЛЛЕЛЬНО — оба стартуют startChatRun, и порядок ответов в ленте
// зависит от того, кто из них первым отрезолвит Pi. Это лечится ровно
// одной очередью на пару (chat_id, role_id): ходы встают в неё и
// обрабатываются строго по порядку FIFO. Другие роли и другие чаты
// продолжают работать параллельно — мьютекс на всю систему здесь был
// бы избыточным.
//
// Тип очереди простой: цепочка promise-ов. enqueueChatReply(fn) берёт
// хвост текущей цепочки, добавляет к нему fn и возвращает новый
// «хвост». Любая следующая постановка в эту же пару будет ждать
// предыдущей, не блокируя другие пары.
//
// Изоляция от startChatRun: acquireChatRoleLock защищает от двух
// ПАРАЛЛЕЛЬНЫХ заходов Pi, а очередь — от двух ОЧЕРЕДНЫХ, но быстро
// подряд прилетевших. Один без другого неполон: лок нужен startChatRun
// для исключения гонки «процесс уже поднят, но ещё не ответил», очередь
// — чтобы выстроить ходы в том порядке, в каком их прислал пользователь.

interface QueueTail {
  // Промис, который резолвится, когда текущий хвост отработает. Следующий
  // enqueueChatReply будет ждать именно этого промиса.
  done: Promise<void>;
}

const chatRoleQueues = new Map<string, QueueTail>();
const scheduledDeliveries = new Map<string,Promise<void>>();
export function isChatDeliveryScheduled(id:string):boolean { return scheduledDeliveries.has(id); }

/** Ключ очереди на пару (chat, role). Тот же формат, что у локов, чтобы
 *  связь была видна: всё, что относится к одной паре, сидит под одним
 *  ключом. */
function queueKey(chatId: string, roleId: string): string {
  return `${chatId}:${roleId}`;
}

/** Поставить ход fn в очередь на пару (chat_id, role_id). Возвращает
 *  промис, который резолвится, когда fn (и все предшествующие в очереди
 *  ходы) отработают. fn сама бросает или возвращает что угодно — мы НЕ
 *  пробрасываем её ошибки в returned promise; внутри fn должна сама
 *  решить, что делать (наш deliverAgentReply логирует и идёт дальше,
 *  чтобы не ломать HTTP-ответ пользователя). */
/** Карточка ebc4d338: обёртки над chatQueue для существующих вызовов.
 *  Запись в durable-лог делегируется chatQueue — этот модуль только
 *  навешивает логирование и сшивает in-memory очередь с БД. */

export {
  bumpChatGeneration,
  currentChatGeneration,
  finishMessageDelivery as completeDurableDelivery,
  fenceMessageDelivery as fenceStaleDeliveries,
} from "./chatQueue.js";

export type { MessageDelivery } from "./chatQueue.js";

/** Подложить durable-запись ДО постановки в in-memory очередь. Если
 *  запись уже есть (тот же delivery_id) — это идемпотентный повтор, и
 *  мы возвращаем прежний id без нового хода.
 *
 *  Вызывающий код (например, deliverAgentReply) сам решает, что
 *  делать с дублем (обычно — повторно ответить, не запуская Pi снова).
 *  Возвращаемое значение — намёк на сценарий:
 *    `created=true`   — первая запись; in-memory очередь обязана
 *                        реально исполнить fn.
 *    `created=false`  — повтор; можно либо проигнорировать, либо
 *                        дать короткий «уже в работе» ответ.
 *
 *  payload — произвольные данные, которые прикладной код сможет
 *  прочитать при recovery (например, текст сообщения и trigger_id). */
export function recordDurableDelivery(input: {
  chatId: string;
  roleId: string;
  deliveryId: string;
  messageId?: string | null;
  payload: unknown;
}) {
  return durableEnqueue({
    chatId: input.chatId,
    roleId: input.roleId,
    deliveryId: input.deliveryId,
    messageId: input.messageId ?? null,
    payload: input.payload,
  });
}

/** Пометить ход в работе — вызывается непосредственно перед запуском
 *  Pi. Это синхронизация, не fence: fence приходит через fenceStaleDeliveries
 *  при bumpChatGeneration. */
export function pickDurableDelivery(deliveryId: string): boolean {
  return claimMessageDelivery(deliveryId);
}

/** Снимок pending-холдов для пары — для recovery после рестарта
 *  in-memory очереди. */
export function listPendingDeliveries(chatId: string, roleId: string) {
  return pendingMessageDeliveries({ chatId, roleId });
}

export function enqueueChatReply<T>(
  chatId: string,
  roleId: string,
  fn: () => Promise<T>,
  options: {deliveryId?:string;waitMs?:number} = {},
): Promise<T> {
  const deliveryId = options.deliveryId;
  if (deliveryId && scheduledDeliveries.has(deliveryId))
    return Promise.reject(Object.assign(new Error("Доставка уже ожидает выполнения"), {code:"CHAT_DELIVERY_ALREADY_SCHEDULED"}));
  const key = queueKey(chatId, roleId);
  const prevDone = chatRoleQueues.get(key)?.done ?? Promise.resolve();
  let releaseGate!: () => void;
  const nextDone = new Promise<void>(resolve => { releaseGate = resolve; });
  chatRoleQueues.set(key, {done:nextDone});
  if (deliveryId) scheduledDeliveries.set(deliveryId,nextDone);
  const release = () => {
    if (deliveryId && scheduledDeliveries.get(deliveryId) === nextDone) scheduledDeliveries.delete(deliveryId);
    releaseGate();
    if (chatRoleQueues.get(key)?.done === nextDone) chatRoleQueues.delete(key);
  };
  const configured = Number(options.waitMs ?? process.env.TASKFLOW_CHAT_QUEUE_WAIT_MS ?? 300_000);
  const waitMs = Number.isFinite(configured) && configured > 0 ? configured : 300_000;
  let expired = false;
  return new Promise<T>((resolve,reject) => {
    const timer = setTimeout(() => {
      expired = true;
      if (deliveryId) {
        if (scheduledDeliveries.get(deliveryId) === nextDone) scheduledDeliveries.delete(deliveryId);
        failPendingMessageDelivery(deliveryId, "queue_wait_timeout");
        // Исчерпан срок ожидания очереди: текущий пункт честно помечаем
        // заблокированным с причиной, а не оставляем «тихо не начатым»
        // (карточка b504958a, контракт §7).
        markChatItemBlockedByServer(chatId, roleId, "истёк срок ожидания очереди чата");
      }
      reject(Object.assign(new Error("Истёк срок ожидания очереди чата"), {code:"CHAT_QUEUE_WAIT_TIMEOUT"}));
      // Keep FIFO reserved until the previous writer exits. Never steal a live session.
    },waitMs);
    timer.unref?.();
    void prevDone.then(async () => {
      clearTimeout(timer);
      if (expired) { release(); return; }
      let stopHeartbeat = () => {};
      try {
        if (deliveryId) {
          if (!claimMessageDelivery(deliveryId))
            throw Object.assign(new Error("Доставка уже обработана или отменена"), {code:"CHAT_DELIVERY_NOT_PENDING"});
          stopHeartbeat = startDeliveryHeartbeat(deliveryId);
        }
        resolve(await fn());
      } catch (error) { reject(error); }
      finally { stopHeartbeat(); release(); }
    });
  });
}

/** Снимок состояния очередей — для админки/отладки. Возвращаем только
 *  размер: достаточно понять «висит ли что-то». */
export function chatReplyQueueDepth(chatId: string, roleId: string): number {
  // Без счётчика честно посчитать сложно, а заводить счётчик только
  // ради отладки — лишнее состояние. Возвращаем 1, если очередь есть
  // (значит, как минимум один ход в полёте или ждёт), иначе 0.
  return chatRoleQueues.has(queueKey(chatId, roleId)) ? 1 : 0;
}

/** Тестовая утилита: сбросить все очереди. В проде не нужна — после
 *  рестарта процесса карта и так пуста. */
export function _resetChatRoleQueuesForTests(): void {
  chatRoleQueues.clear();
  scheduledDeliveries.clear();
}
