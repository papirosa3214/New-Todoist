// Правила рутин — чистые функции без БД и без Fastify.
//
// Здесь вся арифметика «когда в следующий раз сработать»:
// правило → местное время в зоне рутины → ближайший момент запуска.
// Модуль runtime/schedules/ (вариант B из заметки «Рутины и расписание
// TaskFlow»): правила вынесены из общего планировщика, у них свои тесты.
//
// Зона рутины — IANA («Europe/Moscow» по умолчанию). Расчёт идёт через
// Intl.DateTimeFormat, а НЕ через Date.setUTC*: при смене зоны (DST,
// переезд) такая арифметика съезжает на час.

export type ScheduleRuleKind =
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "weekly_days"
  | "interval";

export const SCHEDULE_RULE_KINDS: ScheduleRuleKind[] = [
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "weekly_days",
  "interval",
];

/** Минимальный интервал — 5 минут (интервал обхода планировщика). */
export const MIN_INTERVAL_MINUTES = 5;
/** Окно догона: просроченный запуск догоняем один раз, если прошло меньше суток. */
export const CATCH_UP_HOURS = 24;

export interface ScheduleRule {
  kind: ScheduleRuleKind;
  /** Для weekly_days — «1,3,5» (ISO: 1=Пн..7=Вс); для interval — «15m»/«2h». */
  expr: string | null;
  /** «ЧЧ:ММ» местного времени рутины. */
  timeLocal: string;
  /** IANA-зона рутины. */
  timezone: string;
  /** Дата, от которой считаются «раз в неделю» и «раз в месяц». */
  anchor: { year: number; month: number; day: number };
}

export interface ZonedParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number;
  minute: number;
  /** ISO: 1=Пн..7=Вс. */
  weekday: number;
}

const WEEKDAY_BY_SHORT: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** Местные части момента в зоне рутины. */
export function zonedParts(instant: Date, timezone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour")) % 24; // en-CA в полночь иногда отдаёт 24
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    weekday: WEEKDAY_BY_SHORT[get("weekday")] ?? 1,
  };
}

/** Смещение зоны в миллисекундах на момент instant. */
function zoneOffsetMs(instant: Date, timezone: string): number {
  const p = zonedParts(instant, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  // Минуты теряются при переводе в UTC — компенсируем разницу целой минуты.
  const whole = asUtc - instant.getTime();
  const minuteRemainder = instant.getTime() % 60_000;
  return whole - minuteRemainder;
}

/**
 * Местное время рутины → момент UTC. Два прохода: первый даёт смещение,
 * второй — поправку на границу DST (часа в сутки «не существует» или
 * «повторяется»).
 */
export function zonedToUtc(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): Date {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let ts = guess - zoneOffsetMs(new Date(guess), timezone);
  ts = guess - zoneOffsetMs(new Date(ts), timezone);
  return new Date(ts);
}

export function parseTimeLocal(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** «15m» / «2h» → минуты. Меньше пяти минут — нельзя. */
export function parseIntervalMinutes(expr: string | null): number | null {
  const m = /^(\d+)\s*([mhd])$/i.exec(String(expr ?? "").trim());
  if (!m) return null;
  const amount = Number(m[1]);
  const unit = m[2].toLowerCase();
  const minutes = unit === "m" ? amount : unit === "h" ? amount * 60 : amount * 1440;
  if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES) return null;
  return minutes;
}

/** «1,3,5» → {1,3,5} (ISO: 1=Пн..7=Вс). */
export function parseWeekdays(expr: string | null): Set<number> | null {
  const raw = String(expr ?? "").trim();
  if (!raw) return null;
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < 1 || n > 7) return null;
    out.add(n);
  }
  return out.size ? out : null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(parts: { year: number; month: number; day: number }, days: number) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function weekdayOf(parts: { year: number; month: number; day: number }): number {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const js = d.getUTCDay(); // 0=Вс
  return js === 0 ? 7 : js;
}

/** Правило совпадает с этой местной датой? */
export function ruleMatchesDate(rule: ScheduleRule, date: { year: number; month: number; day: number }): boolean {
  const weekday = weekdayOf(date);
  switch (rule.kind) {
    case "daily":
      return true;
    case "weekdays":
      return weekday <= 5;
    case "weekly":
      return weekday === weekdayOf(rule.anchor);
    case "monthly": {
      const anchorDay = Math.min(rule.anchor.day, daysInMonth(date.year, date.month));
      return date.day === anchorDay;
    }
    case "weekly_days": {
      const days = parseWeekdays(rule.expr);
      return days ? days.has(weekday) : false;
    }
    case "interval":
      return true;
  }
}

/**
 * Ближайший момент запуска ПОСЛЕ `from` (строго позже — повторный обход
 * планировщика в то же окно не должен создать вторую карточку).
 *
 * Для interval правило не привязано к календарю: там шаг = база + интервал.
 */
export function nextRunAfter(rule: ScheduleRule, from: Date): Date | null {
  if (rule.kind === "interval") {
    const minutes = parseIntervalMinutes(rule.expr);
    if (!minutes) return null;
    return new Date(from.getTime() + minutes * 60_000);
  }
  const time = parseTimeLocal(rule.timeLocal);
  if (!time) return null;
  const local = zonedParts(from, rule.timezone);
  // Кандидаты: сегодняшний местный день и следующие 400 дней.
  let date = { year: local.year, month: local.month, day: local.day };
  for (let i = 0; i <= 400; i += 1) {
    if (ruleMatchesDate(rule, date)) {
      const candidate = zonedToUtc({ ...date, hour: time.hour, minute: time.minute }, rule.timezone);
      if (candidate.getTime() > from.getTime()) return candidate;
    }
    date = addDays(date, 1);
  }
  return null;
}

export type RunDecisionAction = "run" | "skip";

export interface RunDecision {
  action: RunDecisionAction;
  /** Ключ идемпотентности: слот запуска (не «сейчас»), чтобы второй проход не создал вторую карточку. */
  runAt: Date;
  reason?: string;
}

/**
 * Что делать с наступившим запуском рутины.
 *
 *  - не наступил → skip (рутина ждёт);
 *  - просрочен больше суток → skip («догоняем один запуск, пачку — нет»);
 *  - прошлый экземпляр ещё не закрыт (overlap_policy=skip) → skip;
 *  - иначе run.
 */
export function decideRun(input: {
  now: Date;
  nextRunAt: Date;
  catchUp: boolean;
  overlapOpen: boolean;
  catchUpHours?: number;
}): RunDecision {
  const hours = input.catchUpHours ?? CATCH_UP_HOURS;
  if (input.nextRunAt.getTime() > input.now.getTime()) {
    return { action: "skip", runAt: input.nextRunAt, reason: "ещё не время" };
  }
  const lateMs = input.now.getTime() - input.nextRunAt.getTime();
  if (lateMs > hours * 3_600_000) {
    return { action: "skip", runAt: input.nextRunAt, reason: "просрочено больше окна догона" };
  }
  if (input.overlapOpen) {
    return { action: "skip", runAt: input.nextRunAt, reason: "прошлый экземпляр не закрыт" };
  }
  if (!input.catchUp && lateMs > 60_000) {
    return { action: "skip", runAt: input.nextRunAt, reason: "догон отключён" };
  }
  return { action: "run", runAt: input.nextRunAt };
}
