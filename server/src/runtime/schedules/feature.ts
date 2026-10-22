// Выключатели рутин: два переключателя для выкладки и отката.
//
// TASKFLOW_ROUTINES_ENABLED=0 — рутины выключены целиком: создание и
// правка запрещены (503), тик ничего не запускает. Чтение списка и
// истории остаётся, чтобы владелец видел, что записи есть.
//
// TASKFLOW_ROUTINES_TICK_ENABLED=0 — выключен только запуск по расписанию:
// ручная кнопка «Запустить сейчас» и правка рутин продолжают работать.
//
// Значение по умолчанию — «включено»: механизм уже слит в главную ветку,
// а выключатель нужен для быстрого отката без новой выкладки.
//
// Формат значения: «0», «false», «off», «no», «выкл» — выключено;
// всё остальное непустое — включено. Пустая переменная — как default.

const OFF_VALUES = new Set(["0", "false", "off", "no", "выкл", "нет"]);

function flagOn(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (!value) return fallback;
  return !OFF_VALUES.has(value);
}

/** Рутины включены целиком (создание, правка, запуск). */
export function routinesEnabled(): boolean {
  return flagOn("TASKFLOW_ROUTINES_ENABLED", true);
}

/** Запуск по расписанию включён (ручной запуск работает всегда). */
export function routinesTickEnabled(): boolean {
  return flagOn("TASKFLOW_ROUTINES_TICK_ENABLED", true);
}
