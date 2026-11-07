import db from "../db.js";

/** Закрыть осиротевшие попытки ролей (владелец 24.10.2026). Рестарт сервера
 *  обрывает in-process запуски ролей, а строка попытки остаётся
 *  `ended_at IS NULL` навсегда — они копятся и врут статистике. На старте
 *  закрываем все открытые (живых запусков ещё нет), периодически — только
 *  с протухшим пульсом (запуск умер без рестарта). */
export function closeOrphanedAttempts(maxAgeMinutes?: number): number {
  const rows = (
    maxAgeMinutes
      ? db
          .prepare(
            // `heartbeat_at IS NULL` — ВАЖНО (24.10.2026, аудит надёжности).
            // Попытки заводятся БЕЗ heartbeat_at: createAttempt в
            // PiRuntimeAdapter.ts не пишет эту колонку, и roleLoadWatcher тоже.
            // В SQLite сравнение с NULL даёт NULL (не true), поэтому строка
            // `heartbeat_at < datetime(...)` для них НЕ срабатывает — и
            // периодический проход (раз в 6 часов) их никогда не закрывал:
            // попытка висела `ended_at IS NULL` навсегда, занимала слот по
            // UNIQUE-индексу и не давала новой попытке по той же задаче.
            //
            // NULL — это «пульса не было никогда», то есть попытка тем более
            // протухла: её надо закрывать по тому же правилу, что и заведомо
            // устаревшую.
            `SELECT id FROM attempts
              WHERE ended_at IS NULL
                AND (heartbeat_at IS NULL OR heartbeat_at < datetime('now', ?))`,
          )
          .all(`-${maxAgeMinutes} minutes`)
      : db.prepare(`SELECT id FROM attempts WHERE ended_at IS NULL`).all()
  ) as Array<{ id: string }>;
  if (rows.length === 0) return 0;
  const close = db.prepare(
    `UPDATE attempts SET ended_at = datetime('now'), outcome = 'interrupted', reason = 'перезапуск сервера' WHERE id = ? AND ended_at IS NULL`,
  );
  db.transaction((ids: string[]) => {
    for (const id of ids) close.run(id);
  })(rows.map((r) => r.id));
  console.log(`[orphanedAttempts] закрыто осиротевших попыток: ${rows.length}`);
  return rows.length;
}

/** Периодический проход: раз в 6 часов закрывать попытки с протухшим пульсом
 *  (запуск роли умер без рестарта сервера). */
export function startOrphanedAttemptSweep(
  intervalMs = 6 * 60 * 60_000,
  maxAgeMinutes = 10,
): () => void {
  const timer = setInterval(() => {
    try {
      closeOrphanedAttempts(maxAgeMinutes);
    } catch (error) {
      console.warn("[orphanedAttempts] проход не удался:", error instanceof Error ? error.message : error);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
