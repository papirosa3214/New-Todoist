/**
 * Журнал привязок телефонов: сколько он живёт и кто его чистит.
 *
 * Таблицу `device_events` пишут привязка и отзыв (routes/pairing.ts,
 * routes/devices.ts), и на ней же считаются лимиты попыток обмена
 * (routes/pairing.ts). Живёт журнал 30 дней — документ решения §11.1.
 *
 * Почему это отдельный файл, а не строка в маршруте: чистка нужна серверу
 * на старте и по расписанию, а маршруты занимаются запросами. Плюс её
 * можно вызвать руками из теста, не поднимая таймеры.
 *
 * Таблицы может ещё не быть (тесты поднимают БД до произвольной миграции,
 * миграция 141_device_pairing — позже). Отсутствующая таблица — не ошибка:
 * журнала в этой базе просто ещё нет, и чистить нечего.
 */
import db from "../db.js";

/** Срок жизни журнала — 30 дней (§11.1). */
export const DEVICE_EVENTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Как часто повторять чистку на живом сервере (§11.1: «раз в 6 часов»). */
export const DEVICE_EVENTS_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Удаляет записи журнала старше срока. Возвращает число удалённых строк.
 *
 * created_at хранится ISO-строкой, поэтому сравнение `< ?` лексикографическое
 * и одинаково верное с миллисекундами и без них — тот же приём, что в
 * pruneServerEvents (lib/serverEvents.ts).
 *
 * Порог можно задать `retentionMs`, чтобы тест проверил границу, не ждя
 * тридцати дней.
 */
export function pruneDeviceEvents(
  options: { retentionMs?: number; now?: Date } = {},
): number {
  const now = options.now ?? new Date();
  const retentionMs = options.retentionMs ?? DEVICE_EVENTS_RETENTION_MS;
  const thresholdIso = new Date(now.getTime() - retentionMs).toISOString();
  try {
    const removed = db
      .prepare("DELETE FROM device_events WHERE created_at < ?")
      .run(thresholdIso);
    return Number(removed.changes ?? 0);
  } catch {
    // Таблицы нет (или база недоступна) — журнала чистить нечего. Ронять
    // из-за этого сервер нельзя: чистка фоновой операцией не должна
    // поднимать ошибку на каждый запрос.
    return 0;
  }
}

/**
 * Чистка при старте и раз в 6 часов. Возвращает функцию остановки —
 * её вешают на `onClose`, чтобы тесты и перезапуск не держали таймер.
 *
 * Ошибки глушатся в console.warn по той же причине, что и в serverEvents:
 * фоновая операция не должна ронять процесс.
 */
export function startDeviceEventCleanup(
  options: { retentionMs?: number; intervalMs?: number } = {},
): () => void {
  const run = () => {
    try {
      const removed = pruneDeviceEvents({ retentionMs: options.retentionMs });
      if (removed > 0) {
        console.warn(
          `[device-events] журнал привязок почищен: удалено строк старше срока — ${removed}`,
        );
      }
    } catch (error) {
      console.warn(
        "[device-events] чистка журнала не прошла:",
        error instanceof Error ? error.message : error,
      );
    }
  };

  run(); // при старте
  const timer = setInterval(
    run,
    options.intervalMs ?? DEVICE_EVENTS_CLEANUP_INTERVAL_MS,
  );
  timer.unref(); // не держит процесс живым ради таймера
  return () => clearInterval(timer);
}