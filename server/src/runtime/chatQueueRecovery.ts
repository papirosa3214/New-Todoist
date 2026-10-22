import db from "../db.js";
// Recovery worker для durable-очереди сообщений роли.
//
// Карточка ebc4d338 (queue_repair, 09.10.2026): после рестарта процесса
// in-memory очередь `chatRoleQueues` пуста — сервер потерял все
// неотвеченные ходы. Durable-лог в `chat_message_queue` помнит, что
// за ходы были приняты и НЕ закрыты. Этот worker пробегается по
// `status='pending'` при старте (после listen) и:
//   1. для каждого pending-хода валидирует `session_generation`
//      против текущей generation пары — старые ходы fence-ятся в
//      `superseded` сразу же (cold fence);
//   2. актуальные pending передаются в `recoverAgentDelivery`,
//      который делает ту же цепочку, что и живой маршрут:
//      `pick` ДО постановки в in-memory очередь, реальный
//      Pi-вызов, двойная generation-проверка (после Pi) и
//      `completeDurableDelivery(id, true|false)` в finally;
//   3. fence после Pi (hot fence) — ответ из старой generation
//      не публикуется, даже если Pi успел его сгенерировать.
//
// Семантика «ответ старой сессии прилетел ПОСЛЕ того, как кто-то
// увеличил generation» закрыта в `bumpChatGeneration` и в
// `fenceDeliveryIfStale`; этот worker опирается на обе.
//
// Гонка с живым принятием новых сообщений: worker стартует ДО
// того, как живые маршруты примут первый ход. Поэтому в первый
// момент времени worker'у доступны ТОЛЬКО persistent pending —
// новые ещё не существуют. Это ок.

import {
  bumpChatGeneration,
  fenceMessageDelivery,
  getMessageDelivery,
} from "./chatQueue.js";
import { recoverAgentDelivery } from "../routes/chats.js";

interface RecovererHandle {
  stop: () => void;
  /** Сколько pending было поднято при recovery sweep. */
  recovered: number;
}

/** Один проход по durable pending: fence устаревших, реальные
 *  pending передаём в recoverAgentDelivery, который сделает ту
 *  же цепочку, что и живой /messages. Возвращаем число ходов,
 *  отданных в работу (реальный Pi в их счёт не входит — это метрика
 *  «сколько durable было поднято»; выполнение Pi живёт в логах
 *  startChatRun). */
export async function sweepRecoverableDeliveries(now?: number): Promise<number> {
  void now;
  // Snapshot lightweight identities, not payloads. The UI reader defaults
  // to 50 rows; recovery must cover every obligation accepted before boot.
  const pending = db.prepare(`SELECT id, chat_id, role_id FROM chat_message_queue
    WHERE status='pending' ORDER BY created_at, rowid`).all() as Array<{
      id: string; chat_id: string; role_id: string;
    }>;
  let recovered = 0;
  for (const row of pending) {
    try {
      const result = await recoverAgentDelivery({
        chatId: row.chat_id,
        roleId: row.role_id,
        deliveryId: row.id,
      });
      if (result.status === "done") recovered += 1;
    } catch (error) {
      // One corrupt record must not strand unrelated chats at startup.
      // Keep its durable state for diagnosis; never silently acknowledge it.
      console.warn(`[chatQueueRecovery] delivery ${row.id} failed:`, error);
    }
  }
  return recovered;
}

/** Обертка: зарегистрировать recovery-sweep на старте процесса.
 *  Fire-and-forget: старт сервера не должен ждать Pi, иначе
 *  восстановление задержит приём первого сообщения. */
export function startChatQueueRecovery(processStartedAt = new Date(Date.now()-process.uptime()*1000)): RecovererHandle {
  // Only leases from before this process. Fresh pickups are never stolen.
  const cutoff=new Date(Math.floor(processStartedAt.getTime()/1000)*1000-1000).toISOString();
  db.prepare("UPDATE chat_message_queue SET status='pending',picked_at=NULL,updated_at=datetime('now') WHERE status='picked' AND julianday(updated_at)<julianday(?)").run(cutoff);
  let recovered = 0;
  void sweepRecoverableDeliveries().then((n) => {
    recovered = n;
  }).catch((error) => {
    // Восстановление НЕ должно ломать подъём сервера.
    console.warn("[chatQueueRecovery] sweep при старте не удался:", error);
  });
  return {
    stop: () => {},
    recovered,
  };
}

/** Синхронизация раз в N секунд — ловит pending, оставшиеся
 *  в БД после часов простоя, когда /messages не заходило.
 *  Прямо сейчас мы НЕ планируем периодический вызов (см.
 *  ограничения в документе карточки): текущий sweep делается
 *  раз в старт процесса, а сам факт «запоздалый ход»
 *  распознаётся любым следующим /messages для этой пары.
 *  Функция оставлена как точка расширения. */
export function scheduleChatQueueRecovery(intervalSeconds = 600): () => void {
  const ms = Math.max(60, intervalSeconds) * 1000;
  const timer = setInterval(() => {
    void sweepRecoverableDeliveries().catch((error) => {
      console.warn("[chatQueueRecovery] periodic sweep не удался:", error);
    });
  }, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Служебный хелпер для тестов: явно bumpGeneration с меткой
 *  восстановления — это документирует, что восстановление
 *  fence-ит «запоздавший ответ», не претендуя на координацию
 *  с живым /new-session. */
export function recoveryBumpChatGeneration(chatId: string, roleId: string): number {
  return bumpChatGeneration({ chatId, roleId, reason: "recovery_sweep" }).generation;
}

// Тип-хелпер для тестов: вернуть живую durable-запись по id.
export function _getRecoveryRow(id: string) {
  return getMessageDelivery(id);
}

// Re-export fenceMessageDelivery — нужен местами в тестах для
// ручной эмуляции state «уже superseded».
export { fenceMessageDelivery };

// Re-export helper для прямого вызова из тестов (без sweep'а).
export { recoverAgentDelivery } from "../routes/chats.js";
