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
import {
  roleIsBusyNow,
  sweepFailedDeliveries,
  sweepStalledDeliveries,
} from "./chatDeliveryWatch.js";

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
  // Мёртвые доставки (старше порога) — в терминальный статус: иначе они
  // держат сторож выкладки и правка в main не доезжает до живого сервера.
  const expired = expireStaleDeliveries();
  if (expired > 0) console.log(`[chatQueueRecovery] закрыто мёртвых доставок: ${expired}`);
  let recovered = 0;
  void sweepRecoverableDeliveries().then((n) => {
    recovered = n;
  }).catch((error) => {
    // Восстановление НЕ должно ломать подъём сервера.
    console.warn("[chatQueueRecovery] sweep при старте не удался:", error);
  });
  // Ходы, упавшие в прошлой сессии сервера, — поднимаем заново: после
  // рестарта их больше некому поднять (владелец 23.10.2026).
  void sweepFailedDeliveries().catch((error) => {
    console.warn("[chatDeliveryWatch] повтор упавших ходов при старте не удался:", error);
  });
  return {
    stop: () => {},
    recovered,
  };
}

/**
 * Срок жизни доставки в очереди чата (минуты).
 *
 * Доставка, которую никто не забрал (или ход которой умер вместе с
 * процессом), остаётся в статусе `pending`/`picked` НАВСЕГДА: возврат в
 * очередь есть только при старте сервера. Такая «мёртвая» доставка
 * считалась сторожем выкладки занятой системой — правка в `main` лежала
 * часами (карточка 568a2b93, 21.10.2026: очередь чата держала выкладку
 * 31,6 часа).
 *
 * Теперь у доставки есть срок жизни: не взятая за порог доставка
 * переводится в терминальный статус `failed` и больше не держит выкладку.
 * Порог по умолчанию — 60 минут; меняется переменной окружения
 * `TASKFLOW_CHAT_DELIVERY_TTL_MIN` (сторож выкладки читает ту же).
 */
export function chatDeliveryTtlMinutes(): number {
  const raw = Number(process.env.TASKFLOW_CHAT_DELIVERY_TTL_MIN ?? 60);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60;
}

/**
 * Перевести в терминальный статус доставки, которые старше порога.
 * Возвращает число закрытых доставок.
 *
 * Доставки, за которыми сейчас работает роль (ход идёт), не трогаем:
 * порог отсчитывается для действительно мёртвых доставок.
 */
export function expireStaleDeliveries(ttlMinutes: number = chatDeliveryTtlMinutes()): number {
  const cutoff = `-${Math.max(1, Math.floor(ttlMinutes))} minutes`;
  const candidates = db
    .prepare(
      `SELECT id, chat_id, role_id FROM chat_message_queue
        WHERE status IN ('pending', 'picked')
          AND julianday(updated_at) < julianday('now', ?)`,
    )
    .all(cutoff) as Array<{ id: string; chat_id: string; role_id: string }>;
  if (candidates.length === 0) return 0;
  const close = db.prepare(
    `UPDATE chat_message_queue
        SET status = 'failed',
            finished_at = datetime('now'),
            updated_at = datetime('now'),
            payload_json = json_set(COALESCE(payload_json,'{}'),'$.expired',1)
      WHERE id = ? AND status IN ('pending', 'picked')`,
  );
  let closed = 0;
  for (const row of candidates) {
    if (roleIsBusyNow(row.role_id, row.chat_id)) continue;
    closed += close.run(row.id).changes;
  }
  return closed;
}

/** Синхронизация раз в N секунд — ловит pending, оставшиеся
 *  в БД после часов простоя, когда /messages не заходило.
 *  Проход вызывается сервером (index.ts): сперва закрываются доставки
 *  старше порога (их уже никто не заберёт), потом поднимаются живые
 *  pending. До 22.10.2026 функция была написана, но не вызывалась —
 *  поэтому мёртвая доставка жила вечно и держала выкладку сервера
 *  (карточка 568a2b93). */
export function scheduleChatQueueRecovery(intervalSeconds = 600): () => void {
  const ms = Math.max(60, intervalSeconds) * 1000;
  const timer = setInterval(() => {
    // Пинг висящих вопросов — ДО просрочки: истёкшую доставку уже не
    // поднять, а владельцу сказать надо (владелец 23.10.2026).
    try {
      const stalled = sweepStalledDeliveries();
      if (stalled.notified > 0) {
        console.log(
          `[chatDeliveryWatch] висящих вопросов: ${stalled.stalled}, уведомлений владельцу: ${stalled.notified}`,
        );
      }
    } catch (error) {
      console.warn("[chatDeliveryWatch] пинг висящих вопросов не удался:", error);
    }
    try {
      expireStaleDeliveries();
    } catch (error) {
      console.warn("[chatQueueRecovery] просрочка доставок не удалась:", error);
    }
    void sweepRecoverableDeliveries().catch((error) => {
      console.warn("[chatQueueRecovery] periodic sweep не удался:", error);
    });
    // Упавший ход роли поднимаем заново: иначе вопрос остаётся без
    // ответа навсегда (recovery на старте берёт только `pending`).
    void sweepFailedDeliveries().catch((error) => {
      console.warn("[chatDeliveryWatch] повтор упавших ходов не удался:", error);
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

// Признак живого хода роли живёт в стороже доставок: тем же понятием
// пользуется и пинг висящих вопросов, и просрочка доставок. Реэкспорт —
// чтобы старые импорты не сломались.
export { roleIsBusyNow };

// Re-export helper для прямого вызова из тестов (без sweep'а).
export { recoverAgentDelivery } from "../routes/chats.js";
