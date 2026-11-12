/**
 * Отметка активности, пока инструмент работает.
 *
 * Зачем: сторож тишины (inProcessRun.sweepStaleInProcessRuns) считает ход
 * молчащим, если от него 30 минут нет событий. Событие приходит на старте
 * инструмента, а дальше — тишина до конца команды: 40-минутная сборка iOS
 * обрывалась зачисткой на 30-й минуте, хотя всё это время честно работала.
 * Решение — бить в активность по таймеру, пока вызов не вернулся.
 *
 * Модуль намеренно без зависимостей: чем трогать активность, решает вызывающий.
 */

const DEFAULT_EVERY_MS = 60_000;

export function startActivityHeartbeat(input: {
  onBeat: () => void;
  everyMs?: number;
}): () => void {
  const everyMs = input.everyMs && input.everyMs > 0 ? input.everyMs : DEFAULT_EVERY_MS;
  const timer = setInterval(() => {
    try {
      input.onBeat();
    } catch {
      // один неудачный удар не должен останавливать сердцебиение
    }
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
