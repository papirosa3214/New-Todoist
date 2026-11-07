import db from "../db.js";

/**
 * Ротация таблицы model_usage — счётчика расхода моделей.
 *
 * Зачем (24.10.2026, аудит качества данных): таблица растёт без ротации.
 * В живой базе на 24.10.2026 — 63 219 строк при ~5 000 новых в сутки
 * (это самая большая таблица базы, 9,3 МБ). Через год — около 1,8 млн строк.
 *
 * Что можно чистить без потерь: читает эту таблицу только
 * lib/modelUsage.ts, и окно там максимум 30 дней (today / week / month).
 * Всё, что старше 30 дней, не попадает ни в один отчёт.
 *
 * ⚠️ Про trackingSince. Отчёт отдаёт `trackingSince` — с какого момента
 * ведётся учёт (минимальный occurred_at). Если удалить самые старые строки,
 * «учёт с» сдвинется и владелец увидит неверную дату начала. Поэтому
 * самая ранняя строка КАЖДЫЙ пары (provider, model) остаётся навсегда:
 * дата начала по каждой модели сохраняется, а объём уходит.
 *
 * Что удаляется: строки старше срока, у которых есть более поздняя строка
 * той же пары (provider, model).
 */
export const MODEL_USAGE_RETENTION_DAYS = 30;

/** Как часто чистить счётчик расхода. Раз в сутки — запись идёт ~5000/сутки. */
export const MODEL_USAGE_ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Периодическая чистка счётчика расхода моделей.
 *
 * Ротация идёт в фоне процесса сервера — по тем же правилам, что и остальная
 * автоматика (INDEX.md, «Правило приборов и сторожей»): никаких внешних
 * cron'ов и таймеров, всё внутри TaskFlow.
 *
 * Возвращает функцию остановки — её вешает сервер на onClose.
 */
export function startModelUsageRetention(
  intervalMs = MODEL_USAGE_ROTATION_INTERVAL_MS,
  retentionDays = MODEL_USAGE_RETENTION_DAYS,
): () => void {
  const чистка = () => {
    try {
      const удалено = pruneModelUsage(retentionDays);
      if (удалено > 0) {
        console.log(`[model-usage] удалено протухших строк счётчика: ${удалено}`);
      }
    } catch (error) {
      console.warn(
        "[model-usage] чистка не прошла:",
        error instanceof Error ? error.message : error,
      );
    }
  };
  чистка();
  const timer = setInterval(чистка, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Удалить протухшие строки счётчика. Возвращает число удалённых. */
export function pruneModelUsage(retentionDays = MODEL_USAGE_RETENTION_DAYS): number {
  const days = Math.max(1, Math.round(retentionDays));
  // «Есть более поздняя строка той же пары» — та самая, что позволяет не
  // трогать первую запись по каждой паре.
  const info = db
    .prepare(
      `DELETE FROM model_usage
        WHERE occurred_at < datetime('now', ?)
          AND EXISTS (
            SELECT 1 FROM model_usage newer
             WHERE newer.provider = model_usage.provider
               AND newer.model = model_usage.model
               AND newer.occurred_at > model_usage.occurred_at
          )`,
    )
    .run(`-${days} days`);
  return info.changes;
}
