// Форматирование строк рутины — вынесено из экрана, чтобы файл экрана
// экспортировал только компонент (правило быстрого обновления в дев-режиме)
// и чтобы чистые функции можно было проверять тестами без DOM.

import type { ApiSchedule } from "../api/schedules";

/** Дата и время в зоне самой рутины (а не зоне устройства). */
export function formatWhen(value: string | null, timezone: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: timezone,
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toLocaleString("ru-RU");
  }
}

/**
 * Подпись строки: правило (подпись с сервера) + время запуска.
 * Подпись правила приходит с сервера — веб и iOS читают одно и то же
 * поле, поэтому формулировки не расходятся.
 */
export function ruleSummary(schedule: ApiSchedule): string {
  const label = schedule.rule_label || schedule.rule_kind;
  if (schedule.rule_kind === "interval") return label;
  return `${label} в ${schedule.time_local}`;
}
