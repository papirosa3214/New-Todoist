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

/** Дата в зоне рутины: год, месяц, день, час, минуты, ISO-день недели. */
function localParts(value: string, timezone: string) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdays: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  return {
    date,
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: weekdays[get("weekday")] ?? 1,
  };
}

/** Сколько дней между двумя местными датами (по календарю зоны рутины). */
function daysBetween(a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }) {
  const first = Date.UTC(a.year, a.month - 1, a.day);
  const second = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((second - first) / 86_400_000);
}

/**
 * «Следующий запуск» — по-человечески: ближайшие семь дней читаются
 * словами («сегодня в 09:00», «в понедельник в 09:00»), дальше — дата.
 * Время всегда в зоне самой рутины, а не в зоне устройства.
 */
export function formatNextRun(
  value: string | null,
  timezone: string,
  now: Date = new Date(),
): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  let target: ReturnType<typeof localParts>;
  let today: ReturnType<typeof localParts>;
  try {
    target = localParts(value, timezone);
    today = localParts(now.toISOString(), timezone);
  } catch {
    return formatWhen(value, timezone);
  }
  const time = `${String(target.hour).padStart(2, "0")}:${String(target.minute).padStart(2, "0")}`;
  const diff = daysBetween(today, target);
  if (diff === 0) return `сегодня в ${time}`;
  if (diff === 1) return `завтра в ${time}`;
  if (diff > 1 && diff <= 6) {
    let weekday = "";
    try {
      weekday = new Intl.DateTimeFormat("ru-RU", { timeZone: timezone, weekday: "long" }).format(
        target.date,
      );
    } catch {
      weekday = "";
    }
    if (weekday) return `в ${weekday} в ${time}`;
  }
  return formatWhen(value, timezone);
}

/**
 * Текст уведомления о последнем запуске рутины (дизайн, словарь):
 * задача создана, запуск пропущен с причиной или не удался.
 */
export function runNoticeText(status: string | null | undefined, detail: string | null): string {
  if (status === "created") return "Запуск создан";
  if (status === "skipped") return `Пропущено: ${detail ?? "прошлый запуск ещё не закрыт"}`;
  return `Не удалось запустить: ${detail ?? runStatusLabel(status)}`;
}

/** Результат запуска по-русски (дизайн, словарь). */
export function runStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "created":
      return "задача создана";
    case "skipped":
      return "пропущено";
    case "failed":
      return "не создана";
    case "error":
      return "ошибка";
    default:
      return "неизвестный результат";
  }
}
