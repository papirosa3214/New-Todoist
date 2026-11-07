/**
 * Контракт канала команд устройству `device_op` (сервер → телефон).
 *
 * Зачем он: Apple Напоминания и Apple Календарь живут только на айфоне
 * (EventKit в нативном клиенте). Роль работает на сервере .110, значит нужен
 * запрос→ответ по сокету устройства `/ws` — тем же сокетом, что раздаёт
 * события доски. Новый порт и новый вход не заводятся.
 *
 * Источник истины — документ «Контракт канала команд устройству device_op»
 * (заметка ffaf800d-19ad-40e7-8616-9482019f432e). Здесь только типы и имена
 * операций: сервер и iOS-клиент читают одно и то же, иначе команды уйдут
 * в пустоту и «помощник не видит напоминаний» будет неразбираемым.
 *
 * Правила:
 *  - инициатор — сервер: только он шлёт `device_op`, телефон отвечает
 *    `device_op_result` и никогда не начинает диалог сам;
 *  - `opId` обязателен и уникален — это ключ корреляции ответа с запросом;
 *  - телефон отвечает на `opId` ровно один раз, повторный ответ игнорируется;
 *  - неизвестные поля игнорируются, неизвестная операция — ответ
 *    `op_unknown`, а не молчание;
 *  - даты — ISO 8601 в местном времени владельца с часовым поясом
 *    (`2026-10-22T09:00:00+03:00`), для «без времени» — только дата.
 */

/** Версия контракта. Телефон, получивший `v` выше своей, отвечает version_unsupported. */
export const DEVICE_PROTOCOL_VERSION = 1;

/**
 * Потолок ожидания ответа устройства. Сервер может уменьшить, но не
 * увеличить: иначе роль висит на вызове дольше, чем живёт её ход.
 */
export const DEVICE_OP_TIMEOUT_MS = 30_000;

/**
 * Операции устройства (v1). Имена — на стороне телефона; роль их не видит,
 * она видит операции `apple_*` (server/src/runtime/secretaryAppleTools.ts),
 * которые отображаются в эти.
 *
 * Удаления здесь нет намеренно: стирание недоступно Помощнику (право роли
 * режет имя с delete), и в контракт канала оно не входит. Если владелец
 * когда-нибудь разрешит удаление, операцию добавляют сюда — одной строкой.
 */
export const DEVICE_OPS = {
  /** Список напоминаний: {list?, from?, to?, includeCompleted?} */
  reminderList: "reminder.list",
  /** Новое напоминание: {title, dueDate?, list?, notes?, priority?} */
  reminderCreate: "reminder.create",
  /** Закрыть напоминание галочкой: {id} */
  reminderComplete: "reminder.complete",
  /** Перенести напоминание: {id, dueDate} */
  reminderReschedule: "reminder.reschedule",
  /** События календаря за период: {from, to, calendarId?} */
  calendarEvents: "calendar.events",
  /** Новое событие: {title, start, end?, calendar?, location?, notes?, alertMinutesBefore?} */
  calendarEventCreate: "calendar.event.create",
  /** Правка события (перенос, отмена): {id, start?, end?, title?, location?, notes?, cancelled?} */
  calendarEventUpdate: "calendar.event.update",
} as const;

export type DeviceOpName = (typeof DEVICE_OPS)[keyof typeof DEVICE_OPS];

/** Все операции устройства — для проверки «сервер не шлёт чужое». */
export const DEVICE_OP_NAMES: readonly string[] = Object.values(DEVICE_OPS);

/** Сервер → телефон. */
export type DeviceOpRequest = {
  type: "device_op";
  v: number;
  opId: string;
  op: string;
  arguments: Record<string, unknown>;
  timeoutMs?: number;
};

/** Телефон → сервер. */
export type DeviceOpResult = {
  type: "device_op_result";
  v?: number;
  opId: string;
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
};

/**
 * Коды ошибок контракта. `device_*` и `multiple_devices` выбирает сервер,
 * остальные — телефон.
 */
export const DEVICE_ERROR_CODES = [
  "device_offline",
  "device_revoked",
  "multiple_devices",
  "op_unknown",
  "invalid_arguments",
  "access_denied",
  "not_found",
  "version_unsupported",
  "timeout",
  "internal",
] as const;

export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number];

/** Результат операции устройства: успех — данные, отказ — код и текст. */
export type DeviceOpOutcome =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };
