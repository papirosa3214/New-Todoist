// Local-date helpers shared across screens. Using local (not UTC) date
// parts so "today" matches the user's wall clock, not UTC midnight.
//
// ВАЖНО (29.08.2026, f5b8cc34): «сегодня» должно быть московским, а не тем,
// что устройство считает локальным. На iPhone Максима это совпадает, но на
// любом устройстве западнее UTC после 21:00 МСК наступит «вчера», а в
// Калининграде никогда не наступит «сегодня». Поэтому todayStr() идёт
// через Intl с явной зоной Europe/Moscow, а не через локальные компоненты
// Date. Хранение в БД при этом остаётся UTC — это про показ.

import type { ApiTask } from "../api/types";

const MSK_TZ = "Europe/Moscow";

export function todayStr(): string {
  // toLocaleDateString с timeZone даёт календарную дату в указанной зоне
  // независимо от локальной зоны устройства. "en-CA" форматирует как
  // YYYY-MM-DD, что совпадает с форматом due_date в БД.
  return new Date().toLocaleDateString("en-CA", { timeZone: MSK_TZ });
}

// Adds/subtracts whole days from a "YYYY-MM-DD" string, returning the same
// format. Goes through a local Date so month/year rollovers are correct.
export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function tomorrowStr(): string {
  return addDays(todayStr(), 1);
}

// Канонический источник сокращённых названий месяцев (родительный падеж
// без точки: "янв", "авг" — используется в датах задач по всему
// приложению). Раньше был продублирован буквально в InboxScreen.tsx,
// ProjectTasksScreen.tsx, TaskBoard.tsx, TodayScreen.tsx, UpcomingScreen.tsx
// — теперь импортируется отсюда. НЕ путать с MONTHS_ABBR_DOT в
// UpcomingScreen.tsx (другой формат: "Янв.", "Авг." — с точкой и заглавной,
// используется только в заголовке ленты календаря того экрана) — это
// разные наборы для разных мест, не дубль друг друга.
export const MONTHS_SHORT = [
  "янв",
  "фев",
  "мар",
  "апр",
  "мая",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "ноя",
  "дек",
];

// "Срок" row label: relative word for near dates + short date, matching the
// mockup's New Task screen row ("Завтра, 11 авг.", mockup-reference/index.html
// line 1141).
export function formatDueLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDate();
  const month = MONTHS_SHORT[d.getMonth()];
  if (dateStr === todayStr()) return `Сегодня, ${day} ${month}.`;
  if (dateStr === tomorrowStr()) return `Завтра, ${day} ${month}.`;
  // Год показываем ТОЛЬКО когда он не текущий (18.08.2026, владелец
  // запланировал задачу на 2027 и увидел «4 сент.» — по такой подписи год не
  // отличить, и срок читается как «через две недели» вместо «через год»).
  // В текущем году год не пишем: он избыточен и удлиняет бейджи в списках.
  const currentYear = new Date().getFullYear();
  const year = d.getFullYear();
  if (year !== currentYear) return `${day} ${month} ${year}`;
  return `${day} ${month}.`;
}

/** Сколько суток до срока: 0 — сегодня, 1 — завтра, отрицательное — просрочено. */
export function daysUntil(dateStr: string): number {
  // Считаем по календарным суткам, а не по часам: «через сутки» и «завтра» —
  // разные вещи, а человека интересует именно день. Обе даты приводятся к
  // полуночи, поэтому переход через ночь всегда даёт ровно ±1, без дробей и
  // без зависимости от того, в котором часу открыли приложение.
  const цель = new Date(dateStr + "T00:00:00");
  const сегодня = new Date(todayStr() + "T00:00:00");
  return Math.round((цель.getTime() - сегодня.getTime()) / 86_400_000);
}

/** «осталось 3 дня» / «сегодня» / «просрочено на 2 дня» — короткой строкой. */
export function formatDaysLeft(dateStr: string): string {
  const d = daysUntil(dateStr);
  if (d === 0) return "сегодня";
  if (d === 1) return "завтра";
  if (d === -1) return "вчера";
  // Русские окончания: 1 день, 2-4 дня, 5+ дней — плюс исключение для
  // 11-14, где по правилу всегда «дней» (одиннадцать дней, а не «день»).
  const n = Math.abs(d);
  const сотня = n % 100;
  const единица = n % 10;
  const слово =
    сотня >= 11 && сотня <= 14
      ? "дней"
      : единица === 1
        ? "день"
        : единица >= 2 && единица <= 4
          ? "дня"
          : "дней";
  return d > 0 ? `осталось ${n} ${слово}` : `просрочено на ${n} ${слово}`;
}

// ═══════════ TIMESTAMPS (comments, notifications, activity, …) ═══════════
// Canonical home for these two — they used to live only in
// ../api/notifications.ts (re-exported from there for backward
// compatibility so its existing import sites don't need touching).

// `created_at` on every table is SQLite's `datetime('now')`:
// "YYYY-MM-DD HH:MM:SS" in UTC with no timezone marker. `new Date(...)`
// would parse that as *local* time, which is off by the local UTC offset
// (e.g. 3h in Moscow). Normalize before parsing.
//
// ЗАЩИТА (29.08.2026, f5b8cc34): не все строки приходят как SQLite. Где-то
// кладётся `new Date().toISOString()` — там уже есть "Z", и слепое
// добавление ещё одного "Z" даст "Invalid Date". Правило: если в строке
// уже есть "T" и суффикс зоны ("Z" или "±HH:MM") — парсить как есть.
export function parseServerDate(value: string): Date {
  // Уже ISO с зоной (toISOString(), "2024-08-29T10:00:00.000Z", "2024-08-29T10:00:00+03:00").
  // Проверяем и Z, и ±HH:MM — обе формы Date принимает нативно.
  if (
    value.includes("T") &&
    (value.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(value))
  ) {
    return new Date(value);
  }
  // SQLite `datetime('now')` → "YYYY-MM-DD HH:MM:SS" в UTC. Меняем пробел
  // на "T" и добавляем "Z", чтобы Date прочитал как UTC, а не как local.
  return new Date(value.replace(" ", "T") + "Z");
}

// ═══════════ "Сегодня" screen: overdue/today split ═══════════
// Single source for "what counts as overdue vs. due today" on the Today
// screen — used by both its list layout (the red "Просрочено" block above
// the regular rows, added earlier per a direct product requirement) and
// its board layout (two columns, same names, same order). Keeping this in
// one place means the two layouts can never quietly disagree about which
// task belongs where. Overdue tasks come back oldest-due-first, matching
// how the list has always shown them.
export function partitionOverdueToday(
  tasks: ApiTask[],
  today: string,
): { overdue: ApiTask[]; todayTasks: ApiTask[] } {
  const overdue = tasks
    .filter(
      (t) => t.due_date !== null && t.due_date < today,
    )
    .sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""));
  const todayTasks = tasks.filter(
    (t) => t.due_date === today,
  );
  return { overdue, todayTasks };
}

// "5 мин. назад" / "вчера" style relative label for any SQLite
// `created_at` string. Use this instead of printing the raw value —
// comments/notifications/activity should never show raw
// "YYYY-MM-DD HH:MM:SS" to the user.
export function formatRelativeTime(sqliteDatetime: string): string {
  const d = parseServerDate(sqliteDatetime);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "только что";
  if (diffMin < 60) return `${diffMin} мин. назад`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH} ч. назад`;
  const diffD = Math.round(diffH / 24);
  if (diffD === 1) return "вчера";
  return `${diffD} дн. назад`;
}

/**
 * Абсолютное время по Москве рядом с относительной подписью
 * (29.08.2026, f5b8cc34). Без него владелец не видит, врёт ли время на
 * три часа: единственная подпись — «5 мин. назад», и проверить её
 * нечем. Сегодняшнее — «02:50», вчера и старше — «28 авг, 23:15».
 * Год опускаем, он и так показан в шапке ленты.
 */
export function formatAbsoluteTime(sqliteDatetime: string): string {
  const d = parseServerDate(sqliteDatetime);
  // Все компоненты даты/времени берём по Москве через Intl, а не через
  // getUTC* — иначе покажем UTC-время события, а владелец ждёт MSK.
  // Один и тот же момент в UTC и в MSK различается на 3 часа, и именно
  // эту разницу и должна показывать новая отметка.
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: MSK_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hh = get("hour");
  const mi = get("minute");
  // Календарный день события по Москве — отдельным Date (полночь этого дня).
  const thatMsk = new Date(`${get("year")}-${get("month")}-${get("day")}T00:00:00Z`);
  const todayMsk = new Date(
    new Date().toLocaleDateString("en-CA", { timeZone: MSK_TZ }) + "T00:00:00Z",
  );
  const dayDiff = Math.round(
    (todayMsk.getTime() - thatMsk.getTime()) / 86_400_000,
  );
  if (dayDiff <= 0) return `${hh}:${mi}`;
  // «28 авг, 23:15»
  const day = thatMsk.getUTCDate();
  const month = MONTHS_SHORT[thatMsk.getUTCMonth()];
  return `${day} ${month}, ${hh}:${mi}`;
}

/** «13:45» + 45 минут → «13:45—14:30». Без длительности — просто «13:45».
 *
 *  Владелец 19.08.2026: «пиши прям тот период, который выбран, чтобы мне
 *  не нужно было потом высчитывать, во сколько я освобожусь». Поэтому
 *  время задачи ВЕЗДЕ печатается интервалом, а не началом плюс отдельной
 *  длительностью: «13:45 · 45 мин» требует сложения в уме, «13:45—14:30»
 *  не требует.
 *
 *  Через полночь конец заворачивается по суткам (23:45 + 30 мин → 00:15):
 *  задача с временем принадлежит одному дню, второй даты в подписи нет и
 *  быть не должно. */
export function formatTimeRange(
  start: string,
  durationMin?: number | null,
): string {
  if (!durationMin) return start;
  const [h, m] = start.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return start;
  const end = (h * 60 + m + durationMin) % (24 * 60);
  const eh = Math.floor(end / 60);
  const em = end % 60;
  return `${start}—${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
}
