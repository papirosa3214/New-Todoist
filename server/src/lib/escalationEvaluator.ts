// Чистая логика эскалации просроченных задач. Никаких SQL/HTTP — только
// данные на входе, данные на выходе. Тесты в server/test/escalation.test.ts
// гоняют именно эту функцию, без поднятия Fastify.
//
// Контракт — `docs/escalation-architecture.md` §3.2, §5, §6. Сторона
// сервера (scheduler ветка notifyOverdue) вызывает selectSteps и для
// каждого отобранного шага делает INSERT OR IGNORE + POST /api/notifications.

export type EscalationChannel = "inapp" | "apns";

export type EscalationStep = {
  after_hours: number; // целое ≥ 0
  priority_max: 1 | 2 | 3 | 4; // 1 — самый срочный; шаг действует на задачах с priority <= priority_max
  channels: EscalationChannel[];
};

export type EscalationRule = {
  enabled: boolean;
  quiet_from: string; // "HH:MM"
  quiet_to: string; // "HH:MM"
  weekdays: number[]; // 1..7, Пн=1
  steps: EscalationStep[];
};

export type EscalationTask = {
  id: string;
  title: string;
  priority: number | null; // 1..4; null трактуется как 4 (фоновая) — спека §6
  due_date: string; // "YYYY-MM-DD"
  status: "active" | "completed";
};

/** «Сейчас» под заданный TZ: YMD-дата, час, минута, день недели 1..7
 *  (Пн=1). Внутреннее представление — без Date#getHours (оно зависит
 *  от локальной TZ машины, на которой запущен Node). */
export function localClock(now: Date, timezone: string): {
  ymd: string;
  hour: number;
  minute: number;
  second: number;
  weekdayMon1to7: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);
  const v = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  const ymd = `${v("year")}-${v("month")}-${v("day")}`;
  const hour = Number(v("hour")) % 24; // Intl иногда отдаёт "24" для полуночи
  const minute = Number(v("minute"));
  const second = Number(v("second"));
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const weekdayMon1to7 = map[v("weekday")] ?? 1;
  return { ymd, hour, minute, second, weekdayMon1to7 };
}

/** Сколько часов прошло после due_date, в долях часа. Отрицательное — задача
 *  ещё в будущем, не считается просрочкой. Из-за того, что due_date — голая
 *  дата без времени, разница в днях считается по YMD, а дробная часть часа
 *  берётся из локального «сейчас». */
export function hoursOverdue(dueDate: string, now: { ymd: string; hour: number; minute: number; second: number }): number {
  if (typeof dueDate !== "string" || dueDate.length < 10) return Number.NEGATIVE_INFINITY;
  const a = ymdToUtc(dueDate);
  const b = ymdToUtc(now.ymd);
  if (a === null || b === null) return Number.NEGATIVE_INFINITY;
  const dayDelta = (b - a) / 86_400_000;
  if (dayDelta < 0) return Number.NEGATIVE_INFINITY;
  return dayDelta * 24 + (now.hour + now.minute / 60 + now.second / 3600);
}

function ymdToUtc(ymd: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
}

/** Применяет «окно тишины» и «дни недели» — если сейчас тишина, эскалация
 *  не идёт ни по одной задаче. now.hour/minute — локальные для TZ владельца;
 *  weekdayMon1to7 — 1..7 (Пн=1). */
export function isInQuietWindow(
  rule: EscalationRule,
  hour: number,
  minute: number,
  weekdayMon1to7: number,
): boolean {
  if (!rule.enabled) return true;
  if (!rule.weekdays.includes(weekdayMon1to7)) return true;
  const [fromH, fromM] = parseHm(rule.quiet_from);
  const [toH, toM] = parseHm(rule.quiet_to);
  if (fromH === null || toH === null) return false;
  const cur = hour * 60 + minute;
  const from = fromH * 60 + fromM;
  const to = toH * 60 + toM;
  // Окно через полночь (напр. 22:00..08:00) — две полуплоскости.
  if (from === to) return false; // нулевая длительность = тишины нет
  if (from < to) return cur >= from && cur < to;
  return cur >= from || cur < to;
}

function parseHm(value: string): [number, number] | [null, null] {
  if (typeof value !== "string") return [null, null];
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return [null, null];
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return [null, null];
  return [h, min];
}

/** Ключ шага — единый формат `p<priority>_h<after_hours>`, напр. `p1_h1`.
 *  Совпадает с notifications.type, который префиксом `escalation_`
 *  отделяет «эту шину» от прочих уведомлений, и с UNIQUE-индексом
 *  escalation_events(task_id, step_key, date(sent_at)). */
export function stepKey(priority: 1 | 2 | 3 | 4, afterHours: number): string {
  return `p${priority}_h${afterHours}`;
}

/** Нормализует steps_json из БД (там лежит JSON-строка) к EscalationStep[].
 *  Тихая защита: всё, что не парсится или не проходит минимальную проверку,
 *  отбрасывается; при полностью пустом массиве возвращаем дефолт — чтобы
 *  у владельца с битой настройкой всё равно что-то работало. */
export function parseSteps(raw: unknown): EscalationStep[] {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return defaultSteps();
    }
  }
  if (!Array.isArray(parsed)) return defaultSteps();
  const out: EscalationStep[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const after = Number(o.after_hours);
    if (!Number.isInteger(after) || after < 0) continue;
    const priRaw = Number(o.priority_max);
    if (![1, 2, 3, 4].includes(priRaw)) continue;
    const channels = Array.isArray(o.channels)
      ? (o.channels.filter((c) => c === "inapp" || c === "apns") as EscalationChannel[])
      : [];
    if (channels.length === 0) continue;
    out.push({ after_hours: after, priority_max: priRaw as 1 | 2 | 3 | 4, channels });
  }
  return out.length > 0 ? out : defaultSteps();
}

export function defaultSteps(): EscalationStep[] {
  return [
    { after_hours: 1, priority_max: 1, channels: ["inapp", "apns"] },
    { after_hours: 4, priority_max: 2, channels: ["inapp", "apns"] },
    { after_hours: 24, priority_max: 3, channels: ["inapp"] },
    { after_hours: 72, priority_max: 4, channels: ["inapp"] },
  ];
}

/** Выбирает шаги, которые должны сработать на задаче прямо сейчас.
 *  Возвращает массив, отсортированный по after_hours ASC.
 *  `now` — UTC-момент; внутри разворачивается под `timezone` владельца. */
export function selectSteps(
  rule: EscalationRule,
  task: EscalationTask,
  now: Date,
  timezone: string,
): EscalationStep[] {
  if (!rule.enabled) return [];
  if (task.status !== "active") return [];
  const clock = localClock(now, timezone);
  if (isInQuietWindow(rule, clock.hour, clock.minute, clock.weekdayMon1to7)) return [];
  const prio: 1 | 2 | 3 | 4 =
    task.priority == null
      ? 4
      : ([1, 2, 3, 4].includes(task.priority) ? (task.priority as 1 | 2 | 3 | 4) : 4);
  const overdue = hoursOverdue(task.due_date, clock);
  if (!Number.isFinite(overdue) || overdue < 0) return [];
  return rule.steps
    .filter((s) => overdue >= s.after_hours && prio <= s.priority_max)
    .slice()
    .sort((a, b) => a.after_hours - b.after_hours);
}

/** Считает, сколько уведомлений прилетит за горизонт `days` при текущих
 *  правилах. Чистая функция — без БД, на входе массив уже отобранных
 *  задач владельца. На каждый день горизонта прибавляем шаги, у которых
 *  after_hours <= (день_горизонта * 24) и priority_max >= priority задачи.
 *  Дубликат «сегодня слали — завтра прилетит тот же step» не учитываем:
 *  preview — это верхняя граница, не точная модель дедупа. */
export function previewNotifications(
  rule: EscalationRule,
  tasks: EscalationTask[],
  days: number,
): { task_id: string; step_key: string; day_offset: number; channel: EscalationChannel }[] {
  if (!rule.enabled) return [];
  if (days <= 0) return [];
  const out: { task_id: string; step_key: string; day_offset: number; channel: EscalationChannel }[] = [];
  for (const t of tasks) {
    if (t.status !== "active") continue;
    const prio: 1 | 2 | 3 | 4 =
      t.priority == null
        ? 4
        : ([1, 2, 3, 4].includes(t.priority) ? (t.priority as 1 | 2 | 3 | 4) : 4);
    for (let d = 0; d < days; d++) {
      for (const s of rule.steps) {
        if (s.after_hours <= d * 24 && prio <= s.priority_max) {
          for (const channel of s.channels) {
            out.push({ task_id: t.id, step_key: stepKey(prio, s.after_hours), day_offset: d, channel });
          }
        }
      }
    }
  }
  return out;
}

/** Валидация PUT /api/escalation/rules. Возвращает массив строк-ошибок; пустой
 *  массив = валидно. Используется и в роуте, и в тестах. */
export function validateRuleInput(input: unknown): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== "object") {
    return ["тело запроса — объект"];
  }
  const o = input as Record<string, unknown>;
  if (typeof o.enabled !== "boolean") errors.push("enabled: boolean");
  if (typeof o.quiet_from !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(o.quiet_from)) errors.push("quiet_from: HH:MM");
  if (typeof o.quiet_to !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(o.quiet_to)) errors.push("quiet_to: HH:MM");
  if (!Array.isArray(o.weekdays)) errors.push("weekdays: number[]");
  else {
    const ok = (o.weekdays as unknown[]).every(
      (n) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 7,
    );
    if (!ok) errors.push("weekdays: числа 1..7 (Пн=1)");
    if ((o.weekdays as unknown[]).length === 0) errors.push("weekdays: хотя бы один день");
  }
  if (typeof o.steps_json !== "string" && !Array.isArray(o.steps)) {
    errors.push("steps_json: строка JSON или steps: массив");
  }
  return errors;
}

