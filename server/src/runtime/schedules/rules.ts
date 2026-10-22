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
  | "interval"
  | "cron";

export const SCHEDULE_RULE_KINDS: ScheduleRuleKind[] = [
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "weekly_days",
  "interval",
];

/**
 * cron в первой версии не поддерживается: произвольное расписание —
 * решение владельца, которое ещё не принято (заметка «Рутины и расписание
 * TaskFlow», развилка B). Разбор выражения в модуле есть, но ручки его не
 * принимают и отказывают явной ошибкой.
 */
export const CRON_RULE_KIND: ScheduleRuleKind = "cron";

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

/** Местная календарная дата момента в зоне рутины. */
export function localDateParts(
  instant: Date,
  timezone: string,
): { year: number; month: number; day: number } {
  const parts = zonedParts(instant, timezone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

/**
 * Якорь правила «раз в неделю» / «раз в месяц».
 *
 * Явный выбор дня из правила (rule_expr) главнее даты создания рутины:
 * клиент выбирает день недели («Еженедельно») или число месяца
 * («Ежемесячно»), и следующий запуск обязан совпадать с этим выбором.
 * Если день не задан — берём дату создания рутины в её зоне.
 *
 * Раньше якорь при создании рутины был фиксированной датой 1970 года, а
 * тик считал от даты создания: рутина один раз срабатывала не в тот день.
 */
export function anchorForRule(
  kind: ScheduleRuleKind,
  expr: string | null,
  fallback: { year: number; month: number; day: number },
): { year: number; month: number; day: number } {
  const raw = String(expr ?? "").trim();
  if (!raw) return fallback;
  if (kind === "monthly") {
    const day = Number(raw);
    if (Number.isInteger(day) && day >= 1 && day <= 31) return { ...fallback, day };
    return fallback;
  }
  if (kind === "weekly") {
    // ISO-день недели: 1=Пн..7=Вс.
    const weekday = Number(raw);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return fallback;
    // Дата с нужным днем недели — любой день этой недели: для «раз в
    // неделю» важен именно день недели, а не число месяца.
    for (let delta = 0; delta < 7; delta += 1) {
      const candidate = addDays(fallback, delta);
      if (weekdayOf(candidate) === weekday) return candidate;
    }
    return fallback;
  }
  return fallback;
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

// ─── cron ───
//
// Пять полей: минуты часы день-месяца месяц день-недели.
// Поддерживаются «*», числа, списки («1,3»), диапазоны («1-5») и шаги («*/15»).

export interface CronExpr {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** «*» в поле дня месяца / дня недели — значит «без ограничения». */
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseCronField(
  field: string,
  min: number,
  max: number,
): Set<number> | null {
  const raw = String(field ?? "").trim();
  if (!raw) return null;
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (!piece) return null;
    const stepMatch = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(piece);
    const rangeExpr = stepMatch ? stepMatch[1] : piece;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let from = min;
    let to = max;
    if (rangeExpr !== "*") {
      if (/^\d+$/.test(rangeExpr)) {
        from = Number(rangeExpr);
        to = stepMatch ? max : from;
      } else if (/^\d+-\d+$/.test(rangeExpr)) {
        const [a, b] = rangeExpr.split("-").map(Number);
        from = a;
        to = b;
      } else {
        return null;
      }
    }
    if (from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) out.add(value);
  }
  return out.size ? out : null;
}

/** Разобрать cron-выражение из пяти полей. Мусор — null. */
export function parseCron(expr: string | null): CronExpr | null {
  const fields = String(expr ?? "").trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = parseCronField(fields[0], 0, 59);
  const hours = parseCronField(fields[1], 0, 23);
  const dom = parseCronField(fields[2], 1, 31);
  const months = parseCronField(fields[3], 1, 12);
  const dow = parseCronField(fields[4], 0, 7);
  if (!minutes || !hours || !months) return null;
  // «*» в поле дня — это «без ограничения», а не «каждый день из списка».
  const domWild = fields[2].trim() === "*";
  const dowWild = fields[4].trim() === "*";
  // День недели 7 в cron означает воскресенье, а 0 — тоже воскресенье.
  const daysOfWeek = new Set<number>();
  for (const day of dow ?? []) daysOfWeek.add(day === 7 ? 0 : day);
  return {
    minutes,
    hours,
    daysOfMonth: dom ?? new Set(Array.from({ length: 31 }, (_, i) => i + 1)),
    months,
    daysOfWeek,
    domRestricted: dom !== null && !domWild,
    dowRestricted: dow !== null && !dowWild,
  };
}

/** День подходит под cron? (дни недели cron: 0=вс..6=сб, 7=вс.) */
function cronMatchesDate(cron: CronExpr, date: { year: number; month: number; day: number }): boolean {
  if (!cron.months.has(date.month)) return false;
  const domOk = cron.daysOfMonth.has(date.day);
  const jsDow = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  const dowOk = cron.daysOfWeek.has(jsDow);
  // Как в cron: если оба поля дня ограничены — день подходит, когда
  // подходит ЛИБО по числу месяца, ЛИБО по дню недели.
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  if (cron.domRestricted) return domOk;
  if (cron.dowRestricted) return dowOk;
  return true;
}

/** Ближайший момент запуска по cron-выражению (строго позже `from`). */
export function nextCronRun(cron: CronExpr, timezone: string, from: Date): Date | null {
  const local = zonedParts(from, timezone);
  let date = { year: local.year, month: local.month, day: local.day };
  const hours = [...cron.hours].sort((a, b) => a - b);
  const minutes = [...cron.minutes].sort((a, b) => a - b);
  for (let i = 0; i <= 400; i += 1) {
    if (cronMatchesDate(cron, date)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const candidate = zonedToUtc({ ...date, hour, minute }, timezone);
          if (candidate.getTime() > from.getTime()) return candidate;
        }
      }
    }
    date = addDays(date, 1);
  }
  return null;
}

/**
 * День недели для правила «Еженедельно»: «3» → 3 (ISO: 1=Пн..7=Вс).
 * Если день не задан — берётся якорь рутины (день создания).
 */
export function parseWeekday(expr: string | null): number | null {
  const raw = String(expr ?? "").trim();
  if (!/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 7 ? n : null;
}

/**
 * День месяца для правила «Ежемесячно»: «15» → 15.
 * Если день не задан — берётся якорь рутины (день создания).
 */
export function parseMonthDay(expr: string | null): number | null {
  const raw = String(expr ?? "").trim();
  if (!/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 31 ? n : null;
}

/** Местная дата якоря — «сегодня» в зоне рутины. */
export function anchorForNow(now: Date, timezone: string): { year: number; month: number; day: number } {
  const local = zonedParts(now, timezone);
  return { year: local.year, month: local.month, day: local.day };
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

/**
 * Сдвиг календарной даты на N дней.
 *
 * Считаем через Date.UTC с переполнением дня (Date.UTC сам разносит
 * «32-е число» на следующий месяц), а НЕ через setUTCDate: в модуле
 * запрещены вызовы Date.setUTC* — иначе при смене зоны арифметика
 * «по календарю» съезжает на час (критерий приёмки 2 из спеки).
 */
function addDays(parts: { year: number; month: number; day: number }, days: number) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
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
    case "weekly": {
      // Явный день в правиле важнее якоря: он задаёт день недели раз и
      // навсегда (иначе якорь «день создания» меняет день запуска).
      const wanted = parseWeekday(rule.expr) ?? weekdayOf(rule.anchor);
      return weekday === wanted;
    }
    case "monthly": {
      const wanted = parseMonthDay(rule.expr) ?? rule.anchor.day;
      const anchorDay = Math.min(wanted, daysInMonth(date.year, date.month));
      return date.day === anchorDay;
    }
    case "weekly_days": {
      const days = parseWeekdays(rule.expr);
      return days ? days.has(weekday) : false;
    }
    case "interval":
      return true;
    case "cron":
      // cron считается отдельно (nextCronRun) — по календарю не отвечаем.
      return false;
  }
}

/**
 * Ближайший момент запуска ПОСЛЕ `from` (строго позже — повторный обход
 * планировщика в то же окно не должен создать вторую карточку).
 *
 * Для interval правило не привязано к календарю: там шаг = база + интервал.
 */
export function nextRunAfter(rule: ScheduleRule, from: Date): Date | null {
  if (rule.kind === "cron") {
    const cron = parseCron(rule.expr);
    if (!cron) return null;
    return nextCronRun(cron, rule.timezone, from);
  }
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

const WEEKDAY_LABELS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const WEEKDAY_FULL_LABELS = [
  "понедельник",
  "вторник",
  "среда",
  "четверг",
  "пятница",
  "суббота",
  "воскресенье",
];

/**
 * Подпись правила по-русски — сервер отдаёт её готовой (дизайн, п. 2.9):
 * веб и iOS читают одно и то же поле, поэтому подписи не разойдутся.
 */
export function ruleLabel(rule: {
  kind: ScheduleRuleKind;
  expr?: string | null;
}): string {
  switch (rule.kind) {
    case "daily":
      return "Ежедневно";
    case "weekdays":
      return "По будням";
    case "weekly": {
      const day = parseWeekday(rule.expr ?? null);
      if (!day) return "Еженедельно";
      return `Еженедельно: ${WEEKDAY_FULL_LABELS[day - 1]}`;
    }
    case "monthly": {
      const day = parseMonthDay(rule.expr ?? null);
      if (!day) return "Ежемесячно";
      return `Ежемесячно: ${day}-е число`;
    }
    case "weekly_days": {
      const days = parseWeekdays(rule.expr ?? null);
      if (!days) return "По выбранным дням";
      const labels = [...days]
        .sort((a, b) => a - b)
        .map((d) => WEEKDAY_LABELS[d - 1] ?? String(d));
      return `По дням: ${labels.join(", ")}`;
    }
    case "interval": {
      const minutes = parseIntervalMinutes(rule.expr ?? null);
      if (!minutes) return "Через интервал";
      if (minutes % 60 === 0 && minutes >= 60) {
        const hours = minutes / 60;
        return `Каждые ${hours} ${hours === 1 ? "час" : hours < 5 ? "часа" : "часов"}`;
      }
      return `Каждые ${minutes} минут`;
    }
    case "cron":
      return `По расписанию cron: ${String(rule.expr ?? "").trim()}`;
    default:
      return "По расписанию";
  }
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
