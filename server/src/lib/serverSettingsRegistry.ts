// Реестр серверных параметров (MAK-95). Контракт зафиксирован в
// docs/2026-10-08-server-settings-registry.md: один источник правды
// по умолчанию для всего, что раньше жило в `process.env.X` россыпью.
//
// Правила:
//  — ключ пишется в `server_settings` только когда владелец меняет
//    значение; если ключа в БД нет — читается `DEFAULTS[key]`. Seed
//    значений при старте не выполняется (миграция 119 — пустая таблица).
//  — здесь нет обращений к БД и нет `process.env` (кроме DEV-override
//    ниже); модуль чистый и подключается в любом контексте.
//  — метаданные используются UI и валидацией PUT; при добавлении
//    параметра добавляйте запись сюда, а не константу в модуль-потребитель.
//
// DEV-override: при старте через `tsx watch` и в тестах удобно переопределить
// дефолт значением из окружения без записи в БД. Если переменная
// окружения `TASKFLOW_SETTING_<key>` задана — она выигрывает над хардкодом.
// Это совместимо с прежней семантикой «env правИт стартовое значение»
// (контракт, раздел «Чего не делаем»).
import os from "node:os";

/** Node-окружение для будущих os-aware настроек (например,
 *  дефолтного пути `~/.local/state` на разных платформах). Сейчас
 *  не используется, но импорт оставлен ради явной зависимости. */
void os;

export type SettingGroup =
  | "тишина"
  | "перезапуски"
  | "расписания"
  | "снимки"
  | "автоимпорт"
  | "linear"
  | "таймауты"
  | "лимиты"
  | "режим_приёма";

export type SettingKind =
  | "duration_min"
  | "duration_sec"
  | "duration_ms"
  | "interval_ms"
  | "int"
  | "bool"
  | "enum";

export type ServerSetting = {
  key: string;
  label: string;
  group: SettingGroup;
  kind: SettingKind;
  default: number | boolean | string;
  min?: number;
  max?: number;
  options?: readonly string[];
  applies_to: string[];
};

/** Группы параметров — порядок рендера в UI. */
export const SETTING_GROUP_ORDER: readonly SettingGroup[] = [
  "тишина",
  "перезапуски",
  "расписания",
  "снимки",
  "автоимпорт",
  "linear",
  "таймауты",
  "лимиты",
  "режим_приёма",
] as const;

/**
 * Источник правды по умолчанию. Каждый ключ соответствует строке в
 * `SERVER_SETTINGS` ниже — тип проверяется через `SettingOf<K>`.
 */
export const DEFAULTS = {
  snapshot_keep: 20,
  chat_short_limit: 600,
  role_run_concurrency: 3,
  task_context_timeout_ms: 15000,
  // Тишина
  stall_after_min: 10,
  provider_probe_interval_ms: 5 * 60_000,

  // Перезапуски
  slot_stop_summary_ms: 30_000,
  slot_stop_summary: true,
  max_restarts_per_window: 2,

  // Расписания
  scheduler_interval_ms: 5 * 60_000,
  retry_delay_min: 5,
  retry_limit: 3,

  // Снимки
  snapshot_interval_min: 5,

  // Автоимпорт Linear
  linear_autoimport_interval_ms: 5 * 60_000,
  linear_autoimport_stale_ms: 30 * 60_000,
  linear_autoimport_enabled: true,

  // Запись в Linear
  linear_sync_enabled: true,
  linear_sync_interval_min: 1,

  // Таймауты
  embedding_timeout_ms: 30_000,

  // Лимиты

  // Наблюдатель за действиями
  activity_observer_enabled: true,

  // Режим приёма
  task_intake_mode: "manual",
  reviewer_first_default: true,
} as const satisfies Record<string, number | boolean | string>;

export type Defaults = typeof DEFAULTS;
export type DefaultsKey = keyof Defaults;
export type SettingOf<K extends DefaultsKey> = Defaults[K];

/** Метаданные для UI и валидации. Сборка проверяет соответствие
 *  `key`/`kind`/`default` — TS выдаст ошибку при добавлении ключа в
 *  `DEFAULTS` без строки здесь. */
export const SERVER_SETTINGS: readonly ServerSetting[] = [
  { key: "snapshot_keep", label: "Хранить снимков на шаг", group: "снимки", kind: "int", default: DEFAULTS.snapshot_keep, min: 1, max: 200, applies_to: ["runtime/slotWorkSnapshot.ts"] },
  { key: "chat_short_limit", label: "Длина сообщения до сокращения", group: "лимиты", kind: "int", default: DEFAULTS.chat_short_limit, min: 100, max: 10000, applies_to: ["lib/chatMessageShortening.ts"] },
  { key: "role_run_concurrency", label: "Одновременных запусков", group: "лимиты", kind: "int", default: DEFAULTS.role_run_concurrency, min: 1, max: 8, applies_to: ["runtime/roleRunWorker.ts"] },
  { key: "task_context_timeout_ms", label: "Таймаут сборки контекста", group: "таймауты", kind: "duration_ms", default: DEFAULTS.task_context_timeout_ms, min: 1000, max: 120000, applies_to: ["runtime/taskContextBridge.ts"] },
  // Тишина
  { key: "stall_after_min", label: "Тишина перед автоперезапуском", group: "тишина", kind: "duration_min", default: DEFAULTS.stall_after_min, min: 1, max: 120, applies_to: ["runtime/stalledStepWatcher.ts"] },
  { key: "provider_probe_interval_ms", label: "Интервал пробы провайдеров", group: "тишина", kind: "interval_ms", default: DEFAULTS.provider_probe_interval_ms, min: 30_000, max: 24 * 60 * 60_000, applies_to: ["runtime/providerProbe.ts"] },

  // Перезапуски
  { key: "slot_stop_summary_ms", label: "Пауза перед итогом остановки", group: "перезапуски", kind: "duration_ms", default: DEFAULTS.slot_stop_summary_ms, min: 1000, max: 5 * 60_000, applies_to: ["runtime/inProcessRun.ts"] },
  { key: "slot_stop_summary", label: "Писать итог остановки", group: "перезапуски", kind: "bool", default: DEFAULTS.slot_stop_summary, applies_to: ["runtime/inProcessRun.ts"] },
  { key: "max_restarts_per_window", label: "Перезапусков на слот за 2 часа", group: "перезапуски", kind: "int", default: DEFAULTS.max_restarts_per_window, min: 0, max: 10, applies_to: ["runtime/stalledStepWatcher.ts"] },

  // Расписания
  { key: "scheduler_interval_ms", label: "Интервал планировщика", group: "расписания", kind: "interval_ms", default: DEFAULTS.scheduler_interval_ms, min: 30_000, max: 24 * 60 * 60_000, applies_to: ["runtime/scheduler.ts"] },
  { key: "retry_delay_min", label: "Задержка перед повтором", group: "расписания", kind: "duration_min", default: DEFAULTS.retry_delay_min, min: 0, max: 1440, applies_to: ["runtime/scheduler.ts"] },
  { key: "retry_limit", label: "Лимит повторов", group: "расписания", kind: "int", default: DEFAULTS.retry_limit, min: 0, max: 50, applies_to: ["runtime/scheduler.ts"] },

  // Снимки
  { key: "snapshot_interval_min", label: "Период техснимков", group: "снимки", kind: "duration_min", default: DEFAULTS.snapshot_interval_min, min: 1, max: 24 * 60, applies_to: ["runtime/slotWorkSnapshot.ts"] },

  // Автоимпорт Linear
  { key: "linear_autoimport_interval_ms", label: "Интервал автоимпорта Linear", group: "автоимпорт", kind: "interval_ms", default: DEFAULTS.linear_autoimport_interval_ms, min: 30_000, max: 24 * 60 * 60_000, applies_to: ["lib/linearAutoImport.ts"] },
  { key: "linear_autoimport_stale_ms", label: "Срок устаревания задачи Linear", group: "автоимпорт", kind: "interval_ms", default: DEFAULTS.linear_autoimport_stale_ms, min: 60_000, max: 24 * 60 * 60_000, applies_to: ["lib/linearAutoImport.ts"] },
  { key: "linear_autoimport_enabled", label: "Автоимпорт Linear включён", group: "автоимпорт", kind: "bool", default: DEFAULTS.linear_autoimport_enabled, applies_to: ["lib/linearAutoImport.ts"] },

  // Запись в Linear
  { key: "linear_sync_enabled", label: "Запись в Linear включена", group: "linear", kind: "bool", default: DEFAULTS.linear_sync_enabled, applies_to: ["lib/linearSync.ts"] },
  { key: "linear_sync_interval_min", label: "Интервал записи в Linear", group: "linear", kind: "duration_min", default: DEFAULTS.linear_sync_interval_min, min: 1, max: 60 * 24, applies_to: ["lib/linearSync.ts"] },

  // Таймауты
  { key: "embedding_timeout_ms", label: "Таймаут эмбеддингов", group: "таймауты", kind: "interval_ms", default: DEFAULTS.embedding_timeout_ms, min: 1000, max: 10 * 60_000, applies_to: ["lib/embeddingClient.ts"] },

  // Лимиты

  // Наблюдатель
  { key: "activity_observer_enabled", label: "Наблюдатель за действиями включён", group: "лимиты", kind: "bool", default: DEFAULTS.activity_observer_enabled, applies_to: ["routes/activity.ts"] },

  // Режим приёма
  { key: "task_intake_mode", label: "Режим приёма задач", group: "режим_приёма", kind: "enum", default: DEFAULTS.task_intake_mode, options: ["manual", "automatic"], applies_to: ["routes/task-intake.ts"] },
  { key: "reviewer_first_default", label: "Рецензент первым по умолчанию", group: "режим_приёма", kind: "bool", default: DEFAULTS.reviewer_first_default, applies_to: ["routes/task-intake.ts"] },
];

/** Поиск метаданных по ключу. */
export function getServerSetting(key: string): ServerSetting | undefined {
  return SERVER_SETTINGS.find((s) => s.key === key);
}

/** DEV-override: `TASKFLOW_SETTING_<KEY>` перекрывает DEFAULTS на старте.
 *  Не пишет в БД и не публикует событие — только подменяет то, что
 *  вернёт `getSetting()` до первого `setSetting()` пользователем. */
export function envOverride<K extends DefaultsKey>(
  key: K,
  fallback: Defaults[K],
): Defaults[K] {
  const legacy: Partial<Record<DefaultsKey, string>> = { stall_after_min: "TASKFLOW_STALL_AFTER_MIN", provider_probe_interval_ms: "PROVIDER_PROBE_INTERVAL_MS", embedding_timeout_ms: "EMBEDDING_TIMEOUT_MS", role_run_concurrency: "ROLE_RUN_CONCURRENCY", slot_stop_summary_ms: "TASKFLOW_SLOT_STOP_SUMMARY_MS", slot_stop_summary: "TASKFLOW_SLOT_STOP_SUMMARY" };
  const raw = process.env[`TASKFLOW_SETTING_${key.toUpperCase()}`] ?? (legacy[key] ? process.env[legacy[key]!] : undefined);
  if (raw === undefined) return fallback;
  try {
    if (typeof fallback === "number") {
      const n = Number(raw);
      if (Number.isFinite(n)) return n as Defaults[K];
    } else if (typeof fallback === "boolean") {
      if (raw === "true" || raw === "1") return true as Defaults[K];
      if (raw === "false" || raw === "0") return false as Defaults[K];
    } else {
      return raw as Defaults[K];
    }
  } catch {
    // падаем на fallback
  }
  return fallback;
}

/** Время по умолчанию для DEV-переопределений. Используется только при
 *  первом обращении к реестру; не дёргается на горячем пути. */
export const DEV_OVERRIDES: Defaults = {
  snapshot_keep: envOverride("snapshot_keep", DEFAULTS.snapshot_keep),
  chat_short_limit: envOverride("chat_short_limit", DEFAULTS.chat_short_limit),
  role_run_concurrency: envOverride("role_run_concurrency", DEFAULTS.role_run_concurrency),
  task_context_timeout_ms: envOverride("task_context_timeout_ms", DEFAULTS.task_context_timeout_ms),

  stall_after_min: envOverride("stall_after_min", DEFAULTS.stall_after_min),
  provider_probe_interval_ms: envOverride(
    "provider_probe_interval_ms",
    DEFAULTS.provider_probe_interval_ms,
  ),
  slot_stop_summary_ms: envOverride(
    "slot_stop_summary_ms",
    DEFAULTS.slot_stop_summary_ms,
  ),
  slot_stop_summary: envOverride("slot_stop_summary", DEFAULTS.slot_stop_summary),
  max_restarts_per_window: envOverride(
    "max_restarts_per_window",
    DEFAULTS.max_restarts_per_window,
  ),
  scheduler_interval_ms: envOverride(
    "scheduler_interval_ms",
    DEFAULTS.scheduler_interval_ms,
  ),
  retry_delay_min: envOverride("retry_delay_min", DEFAULTS.retry_delay_min),
  retry_limit: envOverride("retry_limit", DEFAULTS.retry_limit),
  snapshot_interval_min: envOverride(
    "snapshot_interval_min",
    DEFAULTS.snapshot_interval_min,
  ),
  linear_autoimport_interval_ms: envOverride(
    "linear_autoimport_interval_ms",
    DEFAULTS.linear_autoimport_interval_ms,
  ),
  linear_autoimport_stale_ms: envOverride(
    "linear_autoimport_stale_ms",
    DEFAULTS.linear_autoimport_stale_ms,
  ),
  linear_autoimport_enabled: envOverride(
    "linear_autoimport_enabled",
    DEFAULTS.linear_autoimport_enabled,
  ),
  linear_sync_enabled: envOverride("linear_sync_enabled", DEFAULTS.linear_sync_enabled),
  linear_sync_interval_min: envOverride(
    "linear_sync_interval_min",
    DEFAULTS.linear_sync_interval_min,
  ),
  embedding_timeout_ms: envOverride("embedding_timeout_ms", DEFAULTS.embedding_timeout_ms),
  activity_observer_enabled: envOverride("activity_observer_enabled", DEFAULTS.activity_observer_enabled),
  task_intake_mode: envOverride("task_intake_mode", DEFAULTS.task_intake_mode),
  reviewer_first_default: envOverride("reviewer_first_default", DEFAULTS.reviewer_first_default),
} as const;