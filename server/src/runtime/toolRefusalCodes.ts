// Служебные отказы вызова (P0 карточки e73e7314, правка B1).
//
// Часть отказов приходит не от роли: вызов верный, но сервер его сейчас не
// выполняет — пришло уточнение посреди хода, ход устарел, чек-лист прошлого
// поручения закрыт, операция не подключена к сессии. Такие отказы попадают в
// учёт, чтобы их было видно, но НЕ считаются ошибкой аргументов: иначе три
// служебных отказа за 10 минут гасят живой ход (27.10.2026, карточка
// kb-triage-mvnedwwn — две попытки подряд).
//
// Код — то, что лежит в `role_tool_audit.error_code`: по нему сторож и сводка
// отличают настоящую ошибку роли от служебного отказа.

import { PLANNING_REFUSAL, STEERING_REFUSAL } from "./serverRefusal.js";

export const TOOL_NOT_CONNECTED = "TOOL_NOT_CONNECTED";
export const STEERING_REFUSAL_CODE = "STEERING_REFUSAL";
export const PLANNING_REFUSAL_CODE = "PLANNING_REFUSAL";
export const CHAT_RUN_STALE = "CHAT_RUN_STALE";
export const CHAT_PLAN_CLOSED = "CHAT_PLAN_CLOSED";

/** Коды, которые не являются ошибкой аргументов: вызов не виноват. */
export const SERVICE_REFUSAL_CODES = [
  TOOL_NOT_CONNECTED,
  STEERING_REFUSAL_CODE,
  PLANNING_REFUSAL_CODE,
  CHAT_RUN_STALE,
  CHAT_PLAN_CLOSED,
] as const;

const SERVICE_SET = new Set<string>(SERVICE_REFUSAL_CODES);

/**
 * Текст «инструмента нет в каталоге сессии» — единственный отказ, который
 * означает неподключённую операцию.
 *
 * Раньше служебным объявлялся ЛЮБОЙ текст с «not found»: под это попадали
 * настоящие ошибки аргументов («404: task not found», «subscription not
 * found»). Такие строки вычитались из `errors` в `toolOutcomeStats`, и сторож
 * переставал видеть цикл: роль крутила один и тот же промах без остановки
 * (D1 карточки e73e7314).
 *
 * Формы, которые действительно приходят от рантайма Pi:
 *   • `Tool taskflow_remember not found`
 *   • `Tool "taskflow_remember" not found`
 *   • `инструмент … не найден в каталоге`
 */
const TOOL_NOT_IN_CATALOG_PATTERNS: RegExp[] = [
  // Pi: «Tool taskflow_remember not found», «Tool "…" not found». Слово Tool —
  // с заглавной: иначе под шаблон попадает «… tool id not found» (внутренняя
  // ошибка SDK), а это не неподключённая операция.
  /(?:^|[\s.])Tool\s+["'`«]?[\w.:\-/]+["'`»]?\s+not\s+found/,
  // Со строчной буквы — только имена инструментов роли: без этого «subscription
  // not found» и «plan not found» снова стали бы служебными отказами.
  /(?:^|[\s.])tool\s+(?:taskflow_|mcp__|graft_|web_)[\w.:\-]+\s+not\s+found/i,
  /(?:^|[\s.])tool\s+["'`«](?:taskflow_|mcp__|graft_|web_)[\w.:\-]+["'`»]\s+not\s+found/i,
  /инструмент[а-яё]*[^\n]{0,60}не\s+найден[а-яё]*\s+в\s+каталог/i,
];

/** Отказ «операции нет в каталоге сессии», а не ошибка роли в аргументах. */
export function isToolNotInCatalogText(text: string | null | undefined): boolean {
  if (typeof text !== "string" || !text) return false;
  return TOOL_NOT_IN_CATALOG_PATTERNS.some((re) => re.test(text));
}

export function isServiceRefusalCode(code: string | null | undefined): boolean {
  return typeof code === "string" && SERVICE_SET.has(code);
}

/** Коды через SQL: `error_code IN (...)`. Для сторожей и сводок. */
export function serviceRefusalCodeList(): string[] {
  return [...SERVICE_SET];
}

/**
 * Код служебного отказа по тексту или по коду ошибки. Возвращает `null`,
 * если отказ настоящий (роль ошиблась в вызове) или причина неизвестна.
 *
 * Текст ищем, потому что Pi не кладёт причину в событие вызова — она живёт
 * в тексте результата.
 */
export function serviceRefusalCodeOf(input: {
  code?: string | null;
  text?: string | null;
}): string | null {
  const code = typeof input.code === "string" ? input.code.trim() : "";
  if (code && SERVICE_SET.has(code)) return code;
  const text = typeof input.text === "string" ? input.text : "";
  if (!text) return null;
  if (text.includes(STEERING_REFUSAL)) return STEERING_REFUSAL_CODE;
  if (text.includes(PLANNING_REFUSAL)) return PLANNING_REFUSAL_CODE;
  // Тексты отказов бюджета чата (chatActionBudget.ts) — из отложенных и
  // закрытых поручений, а не из аргументов вызова.
  if (text.includes("Чек-лист прошлого поручения закрыт")) return CHAT_PLAN_CLOSED;
  if (text.includes("Действие устаревшего хода отклонено")) return CHAT_RUN_STALE;
  // Только «инструмента нет в каталоге»: слово «not found» в ответе операции
  // (task/plan/subscription) — настоящая ошибка аргументов, её видно сторожу.
  if (isToolNotInCatalogText(text)) return TOOL_NOT_CONNECTED;
  return null;
}
